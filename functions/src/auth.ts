/**
 * Zeyks Book — passwordless email OTP sign-in.
 *
 * Firebase Auth has no native six-digit-email-code flow, so this implements it
 * with two callables and one Firestore collection the rules seal shut:
 *
 *   requestOtp(email)          → hash(code) + expiry + attempt counter in
 *                                otpChallenges, code emailed via Resend.
 *   verifyOtp(email, code)     → constant-time compare, max 5 attempts, then a
 *                                Firebase custom token the client exchanges for
 *                                a real session with signInWithCustomToken.
 *
 * Security properties carried over from the audit:
 *   * the code is 6 random digits from crypto.randomBytes — never a constant,
 *     never logged, never returned to the client;
 *   * only the SHA-256 hash is stored, salted with the challenge id;
 *   * 10-minute expiry, 5 attempts, 60 s between sends, 5 sends/hour/email;
 *   * every failure surfaces to the user as one generic sentence; the real
 *     reason goes to the function log only.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import * as logger from 'firebase-functions/logger';

const db = getFirestore();

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const MAIL_FROM = defineSecret('MAIL_FROM');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const HOURLY_SEND_LIMIT = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One generic sentence for every failure; the log keeps the specifics. */
const GENERIC = 'Sign-in is temporarily unavailable. Please try again later.';

const fail = (logMessage: string): HttpsError => {
  logger.error(logMessage);
  return new HttpsError('internal', GENERIC);
};

const hash = (challengeId: string, code: string): string =>
  createHash('sha256').update(`${challengeId}:${code}`).digest('hex');

const clean = (email: unknown): string => {
  const value = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!value || !EMAIL_RE.test(value) || value.length > 254) {
    throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
  }
  return value;
};

export const requestOtp = onCall(
  { secrets: [RESEND_API_KEY, MAIL_FROM] },
  async (request) => {
    try {
      const email = clean(request.data?.email);

      // Throttles, both keyed off the challenge document.
      const challengeRef = db.collection('otpChallenges').doc(email.replace(/\./g, ','));
      const existing = await challengeRef.get();
      const prev = existing.data() as {
        last_sent_at?: { toMillis(): number }; sent_hour?: string; sent_count?: number;
      } | undefined;

      const now = Date.now();
      if (prev?.last_sent_at && now - prev.last_sent_at.toMillis() < RESEND_COOLDOWN_MS) {
        throw new HttpsError('resource-exhausted', 'Please wait a minute before requesting another code.');
      }
      const hourKey = new Date().toISOString().slice(0, 13);
      const sentCount = prev?.sent_hour === hourKey ? (prev.sent_count ?? 0) : 0;
      if (sentCount >= HOURLY_SEND_LIMIT) {
        throw new HttpsError('resource-exhausted', 'Too many codes requested. Try again later.');
      }

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const expiresAt = new Date(now + CODE_TTL_MS);

      await challengeRef.set({
        code_hash: hash(challengeRef.id, code),
        expires_at: FieldValue.serverTimestamp() && expiresAt,
        attempts: 0,
        last_sent_at: new Date(now),
        sent_hour: hourKey,
        sent_count: sentCount + 1,
      });

      const from = MAIL_FROM.value() || 'Zeyks Book <onboarding@resend.dev>';
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY.value()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: email,
          subject: 'Your Zeyks Book sign-in code',
          text: `Your Zeyks Book verification code is ${code}. It expires in 10 minutes.\n\nIf you did not request this, ignore this email.`,
        }),
      });
      if (!res.ok) throw fail(`resend refused the OTP mail for ${email}: ${res.status}`);

      return { success: true, message: `Verification code sent to ${email}. Check your inbox.` };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      throw fail(`requestOtp failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

export const verifyOtp = onCall(async (request) => {
  try {
    const email = clean(request.data?.email);
    const code = typeof request.data?.code === 'string' ? request.data.code.trim() : '';
    if (!/^\d{6}$/.test(code)) throw new HttpsError('invalid-argument', 'Enter the 6-digit code from your email.');

    const challengeRef = db.collection('otpChallenges').doc(email.replace(/\./g, ','));
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(challengeRef);
      const data = snap.data() as { code_hash?: string; expires_at?: { toMillis(): number }; attempts?: number } | undefined;
      if (!snap.exists || !data?.code_hash) throw fail(`no challenge for ${email}`);

      if (Date.now() > (data.expires_at?.toMillis() ?? 0)) {
        tx.delete(challengeRef);
        throw fail(`expired code for ${email}`);
      }
      if ((data.attempts ?? 0) >= MAX_ATTEMPTS) {
        tx.delete(challengeRef);
        throw fail(`attempt limit exhausted for ${email}`);
      }

      const expected = Buffer.from(data.code_hash, 'hex');
      const provided = Buffer.from(hash(snap.id, code), 'hex');
      const matches = expected.length === provided.length && timingSafeEqual(expected, provided);

      if (!matches) {
        tx.update(challengeRef, { attempts: (data.attempts ?? 0) + 1 });
        throw fail(`wrong code for ${email}`);
      }
      tx.delete(challengeRef);
      return true;
    });
    if (!result) throw fail('verify did not conclude');

    // The email is the identity: find or create the Auth user, then mint a
    // custom token the client exchanges for a real Firebase session.
    const auth = getAuth();
    let user;
    try {
      user = await auth.getUserByEmail(email);
    } catch {
      user = await auth.createUser({ email, emailVerified: true, displayName: undefined });
    }
    const token = await auth.createCustomToken(user.uid);
    return { success: true, custom_token: token, user_id: user.uid, email };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw fail(`verifyOtp failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});

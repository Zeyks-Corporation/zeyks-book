"use strict";
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
 *   * the code is 6 random digits from crypto.randomInt — never a constant,
 *     never logged, never returned to the client;
 *   * only the SHA-256 hash is stored, salted with the challenge id;
 *   * 10-minute expiry, 5 attempts, 60 s between sends, 5 sends/hour/email;
 *   * invalid or expired codes use one response; rate limits explain when to
 *     retry without revealing whether an account exists.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyOtp = exports.requestOtp = void 0;
const https_1 = require("firebase-functions/v2/https");
const params_1 = require("firebase-functions/params");
const firestore_1 = require("firebase-admin/firestore");
const auth_1 = require("firebase-admin/auth");
const node_crypto_1 = require("node:crypto");
const logger = __importStar(require("firebase-functions/logger"));
const db = (0, firestore_1.getFirestore)();
const RESEND_API_KEY = (0, params_1.defineSecret)('RESEND_API_KEY');
const MAIL_FROM = (0, params_1.defineSecret)('MAIL_FROM');
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const HOURLY_SEND_LIMIT = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** One generic sentence for every failure; the log keeps the specifics. */
const GENERIC = 'Sign-in is temporarily unavailable. Please try again later.';
const fail = (logMessage) => {
    logger.error(logMessage);
    return new https_1.HttpsError('internal', GENERIC);
};
const hash = (challengeId, code) => (0, node_crypto_1.createHash)('sha256').update(`${challengeId}:${code}`).digest('hex');
/** Cross-instance IP throttling for callable requests. IPs are stored as
 * digests and the TTL policy removes the short-lived buckets.
 */
async function allowIpRequest(ip, operation, windowMs, max) {
    const ipHash = (0, node_crypto_1.createHash)('sha256').update(ip).digest('hex');
    const slot = Math.floor(Date.now() / windowMs);
    const ref = db.collection('_otpRateLimits').doc(`${operation}_${ipHash}_${slot}`);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const count = Number(snap.data()?.count) || 0;
        if (count >= max)
            return false;
        tx.set(ref, { count: count + 1, expiresAt: new Date((slot + 2) * windowMs) });
        return true;
    });
}
const clean = (email) => {
    const value = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!value || !EMAIL_RE.test(value) || value.length > 254) {
        throw new https_1.HttpsError('invalid-argument', 'Please enter a valid email address.');
    }
    return value;
};
exports.requestOtp = (0, https_1.onCall)({ secrets: [RESEND_API_KEY, MAIL_FROM] }, async (request) => {
    try {
        const email = clean(request.data?.email);
        const ip = request.rawRequest.ip || 'unknown';
        if (!await allowIpRequest(ip, 'send', 10 * 60000, 30)) {
            throw new https_1.HttpsError('resource-exhausted', 'Too many requests. Please try again later.');
        }
        // Throttles are serialized with the challenge write. The email counter
        // lives apart from the challenge so a successful verification cannot
        // reset the hourly send limit by deleting the challenge.
        const challengeRef = db.collection('otpChallenges').doc(email.replace(/\./g, ','));
        const now = Date.now();
        const code = String((0, node_crypto_1.randomInt)(0, 1000000)).padStart(6, '0');
        const expiresAt = new Date(now + CODE_TTL_MS);
        const hourSlot = Math.floor(now / 3600000);
        const emailHash = (0, node_crypto_1.createHash)('sha256').update(email).digest('hex');
        const emailLimitRef = db.collection('_otpRateLimits').doc(`send_email_${emailHash}_${hourSlot}`);
        const sendResult = await db.runTransaction(async (tx) => {
            const [challenge, emailLimit] = await Promise.all([
                tx.get(challengeRef),
                tx.get(emailLimitRef),
            ]);
            const prev = challenge.data();
            if (prev?.last_sent_at && now - prev.last_sent_at.toMillis() < RESEND_COOLDOWN_MS) {
                return 'cooldown';
            }
            const sentCount = Number(emailLimit.data()?.count) || 0;
            if (sentCount >= HOURLY_SEND_LIMIT)
                return 'hourly-limit';
            tx.set(challengeRef, {
                code_hash: hash(challengeRef.id, code),
                expires_at: expiresAt,
                attempts: 0,
                last_sent_at: new Date(now),
            });
            tx.set(emailLimitRef, {
                count: sentCount + 1,
                expiresAt: new Date((hourSlot + 2) * 3600000),
            });
            return 'sent';
        });
        if (sendResult === 'cooldown') {
            throw new https_1.HttpsError('resource-exhausted', 'Please wait a minute before requesting another code.');
        }
        if (sendResult === 'hourly-limit') {
            throw new https_1.HttpsError('resource-exhausted', 'Too many codes requested. Try again later.');
        }
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
        if (!res.ok)
            throw fail(`resend refused the OTP mail for ${email}: ${res.status}`);
        return { success: true, message: `Verification code sent to ${email}. Check your inbox.` };
    }
    catch (e) {
        if (e instanceof https_1.HttpsError)
            throw e;
        throw fail(`requestOtp failed: ${e instanceof Error ? e.message : String(e)}`);
    }
});
exports.verifyOtp = (0, https_1.onCall)(async (request) => {
    try {
        const email = clean(request.data?.email);
        const code = typeof request.data?.code === 'string' ? request.data.code.trim() : '';
        if (!/^\d{6}$/.test(code))
            throw new https_1.HttpsError('invalid-argument', 'Enter the 6-digit code from your email.');
        const ip = request.rawRequest.ip || 'unknown';
        if (!await allowIpRequest(ip, 'verify', 60000, 30)) {
            throw new https_1.HttpsError('resource-exhausted', 'Too many attempts. Please wait and try again.');
        }
        const challengeRef = db.collection('otpChallenges').doc(email.replace(/\./g, ','));
        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(challengeRef);
            const data = snap.data();
            if (!snap.exists || !data?.code_hash)
                return 'missing';
            if (Date.now() > (data.expires_at?.toMillis() ?? 0)) {
                tx.delete(challengeRef);
                return 'expired';
            }
            if ((data.attempts ?? 0) >= MAX_ATTEMPTS) {
                tx.delete(challengeRef);
                return 'locked';
            }
            const expected = Buffer.from(data.code_hash, 'hex');
            const provided = Buffer.from(hash(snap.id, code), 'hex');
            const matches = expected.length === provided.length && (0, node_crypto_1.timingSafeEqual)(expected, provided);
            if (!matches) {
                tx.update(challengeRef, { attempts: (data.attempts ?? 0) + 1 });
                return 'invalid';
            }
            tx.delete(challengeRef);
            return 'verified';
        });
        if (result !== 'verified') {
            throw new https_1.HttpsError('unauthenticated', 'That code is invalid or expired. Request a new one.');
        }
        // The email is the identity: find or create the Auth user, then mint a
        // custom token the client exchanges for a real Firebase session.
        const auth = (0, auth_1.getAuth)();
        let user;
        try {
            user = await auth.getUserByEmail(email);
        }
        catch {
            user = await auth.createUser({ email, emailVerified: true, displayName: undefined });
        }
        if (!user.emailVerified) {
            user = await auth.updateUser(user.uid, { emailVerified: true });
        }
        const token = await auth.createCustomToken(user.uid);
        return { success: true, custom_token: token, user_id: user.uid, email };
    }
    catch (e) {
        if (e instanceof https_1.HttpsError)
            throw e;
        throw fail(`verifyOtp failed: ${e instanceof Error ? e.message : String(e)}`);
    }
});
//# sourceMappingURL=auth.js.map
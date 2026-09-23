import React, { useState } from 'react';
import { CheckCircle2, Loader2, Mail, MapPin, MessageSquare, Send } from 'lucide-react';
import { PublicLayout } from './PublicLayout';
import { Button, Field, inputClass } from './ui';

export const ContactPage: React.FC<{
  currentPath: string;
  navigate: (to: string) => void;
  onSignIn: () => void;
}> = ({ currentPath, navigate, onSignIn }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, message }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to send message.');
      }

      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message via Resend.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <PublicLayout currentPath={currentPath} navigate={navigate} onSignIn={onSignIn}>
      <section className="mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="max-w-2xl">
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--label-tertiary)]">
            Contact Us
          </p>
          <h1 className="mt-3 text-[34px] font-bold leading-[41px] tracking-[-0.4px] text-[var(--label)]">
            We’d love to hear from you
          </h1>
          <p className="mt-4 text-[17px] leading-[22px] text-[var(--label-secondary)]">
            Have questions about deploying Zeyks Book or setting up your double-entry ledger? Send us a message via Resend.
          </p>
        </div>

        <div className="mt-12 grid gap-10 lg:grid-cols-12">
          {/* Form */}
          <div className="lg:col-span-7 bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] p-6 sm:p-8 shadow-sm">
            {submitted ? (
              <div className="py-12 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--success-bg)] text-[var(--success)]">
                  <CheckCircle2 size={24} strokeWidth={1.8} />
                </div>
                <h2 className="mt-4 text-[22px] font-bold text-[var(--label)]">Message Sent!</h2>
                <p className="mt-2 text-[15px] text-[var(--label-secondary)]">
                  Thank you for reaching out. Your message has been processed via Resend and sent to our team.
                </p>
                <Button
                  variant="secondary"
                  size="md"
                  className="mt-6"
                  onClick={() => {
                    setName('');
                    setEmail('');
                    setMessage('');
                    setSubmitted(false);
                  }}
                >
                  Send another message
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                {error && (
                  <div className="rounded-lg bg-[var(--destructive-bg)] border border-[var(--destructive)]/30 p-3 text-[13px] text-[var(--destructive)]">
                    {error}
                  </div>
                )}

                <Field label="Full Name" required>
                  {(id) => (
                    <input
                      id={id}
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Ram Shrestha"
                      className={inputClass}
                      disabled={loading}
                    />
                  )}
                </Field>

                <Field label="Email Address" required>
                  {(id) => (
                    <input
                      id={id}
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="ram@example.com"
                      className={inputClass}
                      disabled={loading}
                    />
                  )}
                </Field>

                <Field label="Message" required>
                  {(id) => (
                    <textarea
                      id={id}
                      required
                      rows={4}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="How can we help your business?"
                      className={`${inputClass} resize-none`}
                      disabled={loading}
                    />
                  )}
                </Field>

                <Button variant="primary" size="lg" type="submit" className="w-full" disabled={loading}>
                  {loading ? (
                    <Loader2 size={16} className="mr-2 animate-spin" />
                  ) : (
                    <Send size={16} strokeWidth={1.8} className="mr-2" />
                  )}
                  {loading ? 'Sending via Resend…' : 'Send message'}
                </Button>
              </form>
            )}
          </div>

          {/* Info cards */}
          <div className="lg:col-span-5 space-y-4">
            <div className="bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--fill-secondary)] text-[var(--accent)]">
                  <Mail size={18} strokeWidth={1.8} />
                </div>
                <div>
                  <h3 className="text-[15px] font-semibold text-[var(--label)]">Email Service</h3>
                  <p className="text-[13px] text-[var(--label-secondary)]">Contact@zeyksbook.app</p>
                </div>
              </div>
            </div>

            <div className="bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--fill-secondary)] text-[var(--accent)]">
                  <MapPin size={18} strokeWidth={1.8} />
                </div>
                <div>
                  <h3 className="text-[15px] font-semibold text-[var(--label)]">Location</h3>
                  <p className="text-[13px] text-[var(--label-secondary)]">Kathmandu, Nepal</p>
                </div>
              </div>
            </div>

            <div className="bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--fill-secondary)] text-[var(--accent)]">
                  <MessageSquare size={18} strokeWidth={1.8} />
                </div>
                <div>
                  <h3 className="text-[15px] font-semibold text-[var(--label)]">Community Support</h3>
                  <p className="text-[13px] text-[var(--label-secondary)]">+977 9767784817</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
};

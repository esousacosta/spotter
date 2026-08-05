"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { FormEvent, useState } from "react";

export function LoginForm({ authenticationEnabled }: { authenticationEnabled: boolean }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    try {
      if (mode === "signup") {
        const signupResponse = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const signupPayload = (await signupResponse.json()) as { error?: string };
        if (!signupResponse.ok) {
          throw new Error(signupPayload.error ?? "Unable to create account.");
        }
      }

      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (result?.error) {
        throw new Error("Invalid email or password.");
      }

      const callbackUrl = new URLSearchParams(window.location.search).get("callbackUrl");
      window.location.assign(callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//") ? callbackUrl : "/");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to sign in.");
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">Forward Volatility Spotter</p>
        <h1>{mode === "login" ? "Welcome back" : "Create an account"}</h1>
        <p className="section-description">
          {authenticationEnabled
            ? "Sign in to keep your watchlist synced in the local application database."
            : "Authentication is disabled. Set AUTH_ENABLED=true and configure AUTH_SECRET to enable it."}
        </p>

        {authenticationEnabled ? (
          <form onSubmit={onSubmit}>
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={mode === "signup" ? 8 : undefined}
              required
            />
            {error ? <p className="error">{error}</p> : null}
            <button type="submit" className="button-primary" disabled={submitting}>
              {submitting ? "Please wait..." : mode === "login" ? "Log in" : "Create account"}
            </button>
          </form>
        ) : null}

        {authenticationEnabled ? (
          <button
            type="button"
            className="auth-mode-button"
            onClick={() => {
              setMode((current) => (current === "login" ? "signup" : "login"));
              setError(null);
            }}
          >
            {mode === "login" ? "Need an account? Sign up" : "Already have an account? Log in"}
          </button>
        ) : null}
        <Link href="/">Back to the spotter</Link>
      </section>
    </main>
  );
}

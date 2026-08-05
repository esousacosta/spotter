import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

import { getDatabase } from "@/lib/server/db/client";
import { users } from "@/lib/server/db/schema";
import { isAuthenticationEnabled } from "@/lib/server/auth-settings";
import { allowLoginAttempt, clearLoginAttempts } from "@/lib/server/login-rate-limit";

const credentialsSchema = z.object({
  email: z.email().transform((email) => email.trim().toLowerCase()),
  password: z.string().min(1).max(200),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(rawCredentials, request) {
        if (!isAuthenticationEnabled()) {
          return null;
        }

        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) {
          return null;
        }

        const clientAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
        const rateLimitKey = `${clientAddress}:${parsed.data.email}`;
        if (!allowLoginAttempt(rateLimitKey)) {
          return null;
        }

        const user = await getDatabase().query.users.findFirst({
          where: eq(users.email, parsed.data.email),
        });
        if (!user || !(await compare(parsed.data.password, user.passwordHash))) {
          return null;
        }

        clearLoginAttempts(rateLimitKey);
        return { id: user.id, email: user.email };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) {
        token.userId = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && typeof token.userId === "string") {
        session.user.id = token.userId;
      }
      return session;
    },
  },
});

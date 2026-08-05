import { redirect } from "next/navigation";

import { LoginForm } from "@/app/login/login-form";
import { auth } from "@/auth";
import { isAuthenticationEnabled } from "@/lib/server/auth-settings";

export default async function LoginPage() {
  const authenticationEnabled = isAuthenticationEnabled();
  if (authenticationEnabled && (await auth())) {
    redirect("/");
  }

  return <LoginForm authenticationEnabled={authenticationEnabled} />;
}

// Email delivery through the provider's HTTP API (Resend). Supabase functions cannot open SMTP connections.
import type { Config } from "./config.ts";

export interface EmailMessage {
  kind: string;
  to: string;
  subject: string;
  textBody: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
  constructor(private readonly config: Config) {}

  async send(message: EmailMessage): Promise<void> {
    if (!this.config.emailApiKey) throw new Error("EMAIL_API_KEY is not set");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.config.emailApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.config.emailFrom, to: [message.to], subject: message.subject, text: message.textBody }),
    });
    if (!res.ok) {
      // Resend's error name (e.g. "validation_error") says why; its body never contains the API key.
      const name = await res.json().then((j) => String(j?.name ?? "").slice(0, 60)).catch(() => "");
      throw new Error(`email provider answered ${res.status} ${name}`.trim());
    }
    await res.body?.cancel();
    // Never log the recipient or body: the body contains a one-time link.
    console.log(JSON.stringify({ level: "info", msg: "email sent", kind: message.kind }));
  }
}

/** Sends, and logs a failure without the recipient or the body. Returns whether it was sent. */
export async function trySend(sender: EmailSender, message: EmailMessage): Promise<boolean> {
  try {
    await sender.send(message);
    return true;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "email delivery failed", kind: message.kind, error: (e as Error)?.message ?? "Error" }));
    return false;
  }
}

/** Trilingual one-time-link emails (Arabic first). No secrets other than the link itself. */
export function linkEmail(to: string, purpose: string, url: string, validForMinutes: number): EmailMessage {
  const hours = validForMinutes >= 60 ? String(Math.round(validForMinutes / 60)) : null;
  const minutes = String(validForMinutes);
  const [ar, en, tr] = purpose === "setup"
    ? ["إعداد حساب مسؤول الشركة", "Set up your company admin account", "Şirket yönetici hesabınızı kurun"]
    : purpose === "activation"
    ? ["تفعيل حسابك في MEDLINK", "Activate your MEDLINK account", "MEDLINK hesabınızı etkinleştirin"]
    : ["إعادة تعيين كلمة المرور في MEDLINK", "Reset your MEDLINK password", "MEDLINK şifrenizi sıfırlayın"];
  const validAr = hours !== null ? `${hours} ساعة` : `${minutes} دقيقة`;
  const validEn = hours !== null ? `${hours} hour(s)` : `${minutes} minutes`;
  const validTr = hours !== null ? `${hours} saat` : `${minutes} dakika`;
  const body = `${ar}
افتح الرابط التالي لاختيار كلمة المرور وتفعيل التحقق الثنائي. الرابط صالح لمدة ${validAr} ولمرة واحدة فقط.
لن يطلب منك أحد من MEDLINK كلمة المرور أو رمز التحقق أبدًا.

${en}
Open this link to choose your password and set up two-step verification. It works once and expires in ${validEn}.
Nobody from MEDLINK will ever ask you for your password or verification code.

${tr}
Şifrenizi seçmek ve iki adımlı doğrulamayı kurmak için bu bağlantıyı açın. Tek kullanımlıktır ve ${validTr} içinde sona erer.

${url}

KHATIB TECHNICAL SOLUTIONS — الخطيب للحلول التقنية`;
  return { kind: purpose, to, subject: `MEDLINK — ${en} | ${ar}`, textBody: body };
}

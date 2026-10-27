/**
 * Sending a text message.
 *
 * Which provider is used is a deployment decision, not a code one, so this is
 * an interface with the smallest possible surface: a number, a body, and
 * either it was accepted or it threw. Nothing above this layer knows who
 * carries the message.
 *
 * With nothing configured the log provider is used, so the whole chain —
 * trigger, outbox, drain, render — works out of the box and the messages come
 * out in the server log. That is the difference between a feature that is
 * finished and one that is finished except for the part nobody can run.
 */

export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string): Promise<void>;
}

/** Thrown for a number that is unusable, which is permanent, not a retry. */
export class UnsendableError extends Error {}

/** The default: writes the message where whoever runs the drain can see it. */
export const logProvider: SmsProvider = {
  name: "log",
  async send(to, body) {
    console.info(`[sms:log] ${to} ${JSON.stringify(body)}`);
  },
};

/**
 * Twilio, as the common choice. The request is built here and performed by
 * the injected `fetch`, so the shaping of it is testable without a network or
 * an account.
 */
export function twilioProvider(options: {
  accountSid: string;
  authToken: string;
  from: string;
  fetchImpl?: typeof fetch;
}): SmsProvider {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "twilio",
    async send(to, body) {
      const response = await doFetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
          options.accountSid,
        )}/Messages.json`,
        {
          method: "POST",
          headers: {
            // Basic auth, which is what Twilio's REST API takes.
            Authorization: `Basic ${Buffer.from(
              `${options.accountSid}:${options.authToken}`,
            ).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, From: options.from, Body: body }).toString(),
        },
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // 4xx other than rate limiting means this message will never be
        // accepted — a malformed number, usually. Retrying it four more times
        // only delays everything behind it.
        const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
        const message = `twilio ${response.status}: ${detail.slice(0, 200)}`;
        throw permanent ? new UnsendableError(message) : new Error(message);
      }
    },
  };
}

/**
 * Picks the provider from the environment.
 *
 * An incompletely configured provider is a misconfiguration, not a reason to
 * fall silent: it throws rather than quietly logging while the operator
 * believes messages are going out.
 */
export function providerFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): SmsProvider {
  const choice = (env.SMS_PROVIDER ?? "log").toLowerCase();

  if (choice === "log") return logProvider;

  if (choice === "twilio") {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) {
      throw new Error(
        "SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM",
      );
    }
    return twilioProvider({
      accountSid: TWILIO_ACCOUNT_SID,
      authToken: TWILIO_AUTH_TOKEN,
      from: TWILIO_FROM,
    });
  }

  throw new Error(`Unknown SMS_PROVIDER: ${choice}`);
}

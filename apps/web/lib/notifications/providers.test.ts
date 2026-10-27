import { describe, expect, it, vi } from "vitest";
import {
  UnsendableError,
  logProvider,
  providerFromEnvironment,
  twilioProvider,
} from "./providers";

describe("choosing a provider", () => {
  it("logs when nothing is configured, so the chain works out of the box", () => {
    expect(providerFromEnvironment({}).name).toBe("log");
  });

  it("refuses a half-configured provider rather than falling silent", () => {
    // The failure mode this avoids: an operator believing messages are going
    // out because nothing complained.
    expect(() =>
      providerFromEnvironment({ SMS_PROVIDER: "twilio" }),
    ).toThrow(/TWILIO_ACCOUNT_SID/);
  });

  it("refuses a provider it does not have", () => {
    expect(() =>
      providerFromEnvironment({ SMS_PROVIDER: "pigeon" }),
    ).toThrow(/Unknown SMS_PROVIDER/);
  });

  it("builds Twilio when it is fully configured", () => {
    expect(
      providerFromEnvironment({
        SMS_PROVIDER: "twilio",
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "secret",
        TWILIO_FROM: "+212600000000",
      }).name,
    ).toBe("twilio");
  });
});

describe("the Twilio provider", () => {
  const ok = () => new Response("{}", { status: 201 });

  function build(fetchImpl: typeof fetch) {
    return twilioProvider({
      accountSid: "AC123",
      authToken: "secret",
      from: "+212600000000",
      fetchImpl,
    });
  }

  it("posts the message to the account's endpoint", async () => {
    const fetchImpl = vi.fn(ok) as unknown as typeof fetch;
    await build(fetchImpl).send("+212661020304", "Tabib.ma : rappel");

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(init.method).toBe("POST");

    const body = new URLSearchParams(init.body as string);
    expect(body.get("To")).toBe("+212661020304");
    expect(body.get("From")).toBe("+212600000000");
    expect(body.get("Body")).toBe("Tabib.ma : rappel");
  });

  it("authenticates with the account sid and token", async () => {
    const fetchImpl = vi.fn(ok) as unknown as typeof fetch;
    await build(fetchImpl).send("+212661020304", "x");
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(Buffer.from(init.headers.Authorization.slice(6), "base64").toString()).toBe(
      "AC123:secret",
    );
  });

  it("treats a rejected number as permanent, so it is not retried five times", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("invalid To number", { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(build(fetchImpl).send("+2126", "x")).rejects.toBeInstanceOf(UnsendableError);
  });

  it("treats rate limiting and a server fault as worth retrying", async () => {
    for (const status of [429, 500, 503]) {
      const fetchImpl = vi.fn(
        async () => new Response("later", { status }),
      ) as unknown as typeof fetch;
      const error = await build(fetchImpl)
        .send("+212661020304", "x")
        .catch((cause) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UnsendableError);
    }
  });

  it("does not put the auth token in the error it throws", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 401 }),
    ) as unknown as typeof fetch;
    // `send` resolves to void on success, so the catch has to be narrowed
    // rather than assumed — a passing send would otherwise assert nothing.
    const error = await build(fetchImpl)
      .send("+212661020304", "x")
      .then(() => null)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret");
  });
});

describe("the log provider", () => {
  it("accepts anything and says so where the operator can see it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await logProvider.send("+212661020304", "Tabib.ma : rappel");
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toContain("+212661020304");
    info.mockRestore();
  });
});

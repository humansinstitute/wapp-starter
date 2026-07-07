import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

function decodeNsec(input: string): Uint8Array {
  const value = input.trim();
  if (!value) throw new Error("Enter an nsec private key");
  if (/^[0-9a-fA-F]{64}$/.test(value)) return hexToBytes(value);
  if (!value.startsWith("nsec1")) throw new Error("Private key must be nsec1... or 64-char hex");

  const decoded = nip19.decode(value);
  if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
    throw new Error("Private key must be a valid nsec");
  }
  if (decoded.data.length !== 32) throw new Error("Private key must decode to 32 bytes");
  return new Uint8Array(decoded.data);
}

export function derivePubkeyFromNsec(input: string): string {
  return getPublicKey(decodeNsec(input));
}

export function signLoginChallengeWithNsec(input: string, challenge: { nonce: string; content: string }) {
  return finalizeEvent(
    {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["challenge", challenge.nonce], ["client", "chat-wapp"]],
      content: challenge.content,
    },
    decodeNsec(input),
  );
}

export function signEventWithNsec(
  input: string,
  event: { kind: number; created_at: number; tags: string[][]; content: string },
) {
  return finalizeEvent(event, decodeNsec(input));
}

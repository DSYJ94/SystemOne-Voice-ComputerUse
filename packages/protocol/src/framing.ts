import { MAX_MESSAGE_BYTES, ContractError } from './json.ts';
import { decodeMessage, encodeMessage } from './contract.ts';
import type { Message } from './contract.ts';

/** Private app/sidecar framing: unsigned 32-bit big-endian byte count + UTF-8 JSON.
 * Chrome native messaging has a different framing contract and must use an adapter.
 */
export function frame(message: Message): Buffer {
  const payload = encodeMessage(message);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.byteLength);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);
  #failed = false;
  #closed = false;

  push(chunk: Uint8Array): Message[] {
    if (this.#failed || this.#closed) throw new ContractError('transport already failed or closed');
    try {
      if (chunk.byteLength + this.#buffer.byteLength > MAX_MESSAGE_BYTES + 4) {
        throw new ContractError('transport buffer exceeded');
      }
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      const messages: Message[] = [];
      while (this.#buffer.byteLength >= 4) {
        const count = this.#buffer.readUInt32BE();
        if (!count || count > MAX_MESSAGE_BYTES) throw new ContractError('invalid frame size');
        if (this.#buffer.byteLength < 4 + count) break;
        messages.push(decodeMessage(this.#buffer.subarray(4, 4 + count)));
        this.#buffer = Buffer.from(this.#buffer.subarray(4 + count));
      }
      return messages;
    } catch (error) {
      this.#buffer = Buffer.alloc(0);
      this.#failed = true;
      throw error;
    }
  }

  end(): void {
    this.#closed = true;
    if (this.#failed || this.#buffer.byteLength) {
      this.#failed = true;
      throw new ContractError('failed or truncated transport');
    }
  }
}

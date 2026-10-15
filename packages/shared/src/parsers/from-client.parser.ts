import { codec } from 'sjcl';
import { ParserTx } from './parser.interface';

/** Extracts the "client" string from a transaction's `client`-typed memo, if present. */
export class FromClientParser {
  private readonly hexMatch = /^(0x)?[0-9A-Fa-f]+$/;
  private readonly base64Match =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})([=]{1,2})?$/;

  private decodeBase64(data: string): string {
    return codec.utf8String.fromBits(codec.base64.toBits(data));
  }

  private decodeHex(data: string): string {
    return codec.utf8String.fromBits(codec.hex.toBits(data));
  }

  private getClientString(tx: Readonly<Record<string, any>>): string | undefined {
    const memos = tx.Memos as readonly any[] | undefined;
    if (!memos) return undefined;

    for (const wrapper of memos) {
      const memo = wrapper.Memo;
      if (!memo?.MemoType) continue;
      try {
        let type: string;
        if (this.hexMatch.test(memo.MemoType)) type = this.decodeHex(memo.MemoType).toLowerCase();
        else if (this.base64Match.test(memo.MemoType)) type = this.decodeBase64(memo.MemoType).toLowerCase();
        else continue;

        if (type !== 'client') continue;

        const payload = memo.MemoData || memo.MemoFormat;
        if (!payload) continue;
        if (this.hexMatch.test(payload)) return this.decodeHex(payload);
        if (this.base64Match.test(payload)) return this.decodeBase64(payload);
      } catch {
        /* ignore malformed memo */
      }
    }
    return undefined;
  }

  public parse(t: ParserTx): string | null {
    if (!t.tx.Memos) return null;
    const client = this.getClientString(t.tx);
    return client ? client.substring(0, 100) : null;
  }
}

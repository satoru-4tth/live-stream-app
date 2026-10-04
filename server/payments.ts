// 決済プロバイダーの差し替え口。
// 現在は疑似決済 (課金なしで即成功) のみ。本番では Stripe などの実装に置き換える。

export interface TipCharge {
  roomId: string;
  viewerId: string;
  amount: number;
}

export interface PaymentProvider {
  /** 決済に成功したら resolve、失敗したら reject する */
  charge(tip: TipCharge): Promise<void>;
}

const mockProvider: PaymentProvider = {
  async charge() {
    // 疑似決済: 何もしない
  },
};

export const paymentProvider: PaymentProvider = mockProvider;

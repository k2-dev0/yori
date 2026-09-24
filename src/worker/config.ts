// M3 workerの接続・判定設定。環境変数からの読込みと検証はGreenで実装する。
export interface WorkerConfig {
  // Jev APIの完全endpoint。loopback HTTPはテストの合成fixtureにだけ使う。
  apiUrl: string;
  apiKey: string;
  accountRef: string;
  model: string;
  confidenceThreshold: number;
  inputBudgetBytes: number;
  requestTimeoutMs: number;
}

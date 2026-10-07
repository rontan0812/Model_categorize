export type Label = {
  name: string;
  color: string;
};

/** フォルダからの相対パス -> ラベル名の配列 */
export type Assignments = Record<string, string[]>;

/** labels.json の中身 */
export type LabelData = {
  labels: Label[];
  assignments: Assignments;
  /**
   * 人が一度でも手動でラベルを操作した（または確認済みにした）ファイルのパス。
   * ここに無いファイルは「手動未操作」。自動ラベル付けの結果と区別するために使う。
   */
  manual: string[];
};

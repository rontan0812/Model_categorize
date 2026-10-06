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
};

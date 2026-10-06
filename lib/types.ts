export type Label = {
  id: string;
  name: string;
  color: string;
};

/** ファイルパス -> ラベルID の配列 */
export type Assignments = Record<string, string[]>;

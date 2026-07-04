import { Text } from "ink";

// Cat mark: the banner's kaomoji ハ・・マ. Recolor via COLOR.
const COLOR = "#e6932e";

export function Logo() {
  return <Text color={COLOR}>ハ・・マ</Text>;
}

/** A tiny real-JSX tree for the compiled-binary smoke probe (`neko __uiprobe`): exercises the same
 * jsx transform + React runtime pairing the whole UI uses, with a marker the probe greps for. */
export function probeTree() {
  return <Text color={COLOR}>neko-ui-ok</Text>;
}

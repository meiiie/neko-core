import { Text } from "ink";

// Cat mark from the banner (ハ‥マ style: peak, dots, dash, triangle). Recolor via COLOR.
const COLOR = "#e6932e";

export function Logo() {
  return <Text color={COLOR}>/\··─▽</Text>;
}

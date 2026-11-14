# Name

Formula

# Short Description

Wrapper for formulas like "parameter1 + 2.5 * (1mm)"

# Description

A formula calculates a length or an angle. The field supplies the expected dimension. A numeric argument is a length in millimetres or an angle in degrees. A string accepts decimals, arithmetic (`+`, `-`, `*`, `/`), parentheses, and units (`mm`, `cm`, `m`, `in`, `deg`, `rad`). Addition and subtraction require matching dimensions. A dimensionless final result takes the scene unit for the field.

Scenes default to `{ length: "mm", angle: "deg" }`. To select other units, pass them to `core.scene.create(name, { length: "in", angle: "rad" })`. For example, `"2"` in a length field then means two inches, while `"2 cm"` has the same physical length in either scene.

`scene.evaluateFormula(expression, { expectedDimension })` returns the expression, its dimension, and a computed quantity in scene units. A unitless result also records its `implicitUnit`. Passing that result back uses the recorded unit and reevaluates the expression. Extrude preview and commit keep the same data with the feature. Numeric extrusion arguments retain their numeric representation.

## Test cases

- In a default scene, evaluating `"90 / 2"` as an angle returns 45 deg and leaves the timeline empty. The same expression saved with an implicit degree unit retains that angle in a radian scene. An explicit length used as an angle or division by zero raises `INVALID_PARAMETER`.

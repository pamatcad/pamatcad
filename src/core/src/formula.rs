use crate::{
    error::{CoreError, ErrorCode, Result},
    protocol::{
        AngleUnit, EvaluatedFormula, Formula, FormulaDimension, FormulaQuantity, FormulaUnit,
        LengthUnit, SceneUnits,
    },
};

fn invalid(message: &str) -> CoreError {
    CoreError::new(ErrorCode::InvalidParameter, message)
}

impl From<LengthUnit> for FormulaUnit {
    fn from(unit: LengthUnit) -> Self {
        Self::Length(unit)
    }
}

impl From<AngleUnit> for FormulaUnit {
    fn from(unit: AngleUnit) -> Self {
        Self::Angle(unit)
    }
}

impl FormulaUnit {
    fn dimension(self) -> FormulaDimension {
        match self {
            Self::Length(_) => FormulaDimension::Length,
            Self::Angle(_) => FormulaDimension::Angle,
        }
    }

    // The modeling kernel takes millimetres and the extrusion API takes degrees.
    fn scale(self) -> f64 {
        match self {
            Self::Length(LengthUnit::Mm) | Self::Angle(AngleUnit::Deg) => 1.,
            Self::Length(LengthUnit::Cm) => 10.,
            Self::Length(LengthUnit::M) => 1000.,
            Self::Length(LengthUnit::In) => 25.4,
            Self::Angle(AngleUnit::Rad) => 1_f64.to_degrees(),
        }
    }
}

impl SceneUnits {
    pub(crate) fn unit(self, dimension: FormulaDimension) -> FormulaUnit {
        match dimension {
            FormulaDimension::Length => self.length.into(),
            FormulaDimension::Angle => self.angle.into(),
        }
    }
}

impl FormulaDimension {
    fn powers(self) -> [i32; 2] {
        match self {
            Self::Length => [1, 0],
            Self::Angle => [0, 1],
        }
    }
}

pub(crate) struct FormulaEvaluator;

impl FormulaEvaluator {
    pub(crate) fn evaluate<U: Copy + Into<FormulaUnit>>(
        input: &Formula<U>,
        scene_unit: U,
    ) -> Result<EvaluatedFormula<U>> {
        let unit = scene_unit.into();
        let dimension = unit.dimension();
        let (expression, saved_unit) = match input {
            Formula::Number(value) => {
                // Numeric API inputs have always used the kernel's length/angle units.
                let suffix = match dimension {
                    FormulaDimension::Length => "mm",
                    FormulaDimension::Angle => "deg",
                };
                (format!("{value} {suffix}"), None)
            }
            Formula::Expression(source) => (source.clone(), None),
            Formula::Evaluated(bound) => {
                if bound.dimension != dimension
                    || bound
                        .implicit_unit
                        .is_some_and(|u| u.into().dimension() != dimension)
                {
                    return Err(invalid("Stored formula has a different dimension"));
                }
                (bound.expression.clone(), bound.implicit_unit)
            }
        };
        let result = Parser { rest: &expression }.parse()?;
        let (base, implicit_unit) = if result.powers == [0, 0] {
            let implicit = saved_unit.unwrap_or(scene_unit);
            (result.value * implicit.into().scale(), Some(implicit))
        } else if result.powers == dimension.powers() {
            (result.value, None)
        } else {
            return Err(invalid("Formula result has the wrong dimension"));
        };
        let value = base / unit.scale();
        if !base.is_finite() || !value.is_finite() {
            return Err(invalid("Formula result must be finite"));
        }
        Ok(EvaluatedFormula {
            expression,
            dimension,
            implicit_unit,
            computed: FormulaQuantity {
                value,
                unit: scene_unit,
            },
        })
    }
}

impl<U: Copy + Into<FormulaUnit>> Formula<U> {
    /// Bind expression inputs in place for the feature record and return the modeling value.
    pub(crate) fn resolve(&mut self, scene_unit: U) -> Result<f64> {
        if let Self::Number(value) = self {
            return Ok(*value);
        }
        let evaluated = FormulaEvaluator::evaluate(self, scene_unit)?;
        let value = evaluated.computed.value * scene_unit.into().scale();
        *self = Self::Evaluated(evaluated);
        Ok(value)
    }
}

// Intermediate values use base units and the exponents of length and angle. Keeping
// both exponents allows cancellation in expressions like (2 mm * 3 mm) / 1 cm.
struct Quantity {
    value: f64,
    powers: [i32; 2],
}

struct Parser<'a> {
    rest: &'a str,
}

impl Parser<'_> {
    fn parse(mut self) -> Result<Quantity> {
        let result = self.expression(0, 0)?;
        if !self.rest.trim().is_empty() {
            return Err(invalid("Unexpected text after formula"));
        }
        Ok(result)
    }

    fn peek(&mut self) -> Option<u8> {
        self.rest = self.rest.trim_start();
        self.rest.as_bytes().first().copied()
    }

    fn expression(&mut self, minimum: u8, depth: usize) -> Result<Quantity> {
        let mut left = self.operand(depth)?;
        while let Some(op) = self.peek() {
            let precedence = match op {
                b'+' | b'-' => 1,
                b'*' | b'/' => 2,
                _ => break,
            };
            if precedence < minimum {
                break;
            }
            self.rest = &self.rest[1..];
            let right = self.expression(precedence + 1, depth)?;
            match op {
                b'+' | b'-' => {
                    if left.powers != right.powers {
                        return Err(invalid(
                            "Addition and subtraction require matching dimensions",
                        ));
                    }
                    left.value += if op == b'+' {
                        right.value
                    } else {
                        -right.value
                    };
                }
                b'*' => {
                    left.value *= right.value;
                    left.powers = std::array::from_fn(|i| left.powers[i] + right.powers[i]);
                }
                _ => {
                    if right.value == 0. {
                        return Err(invalid("Division by zero"));
                    }
                    left.value /= right.value;
                    left.powers = std::array::from_fn(|i| left.powers[i] - right.powers[i]);
                }
            }
            if !left.value.is_finite() {
                return Err(invalid("Formula result must be finite"));
            }
        }
        Ok(left)
    }

    fn operand(&mut self, depth: usize) -> Result<Quantity> {
        let mut sign = 1.;
        while let Some(op @ (b'+' | b'-')) = self.peek() {
            if op == b'-' {
                sign = -sign;
            }
            self.rest = &self.rest[1..];
        }
        let mut quantity = if self.peek() == Some(b'(') {
            if depth >= 64 {
                return Err(invalid("Too many nested parentheses"));
            }
            self.rest = &self.rest[1..];
            let inside = self.expression(0, depth + 1)?;
            if self.peek() != Some(b')') {
                return Err(invalid("Expected a closing parenthesis"));
            }
            self.rest = &self.rest[1..];
            inside
        } else {
            Quantity {
                value: self.number()?,
                powers: [0, 0],
            }
        };
        quantity.value *= sign;
        if self.peek().is_some_and(|b| b.is_ascii_alphabetic()) {
            let end = self
                .rest
                .bytes()
                .take_while(u8::is_ascii_alphabetic)
                .count();
            let (symbol, rest) = self.rest.split_at(end);
            self.rest = rest;
            let unit: FormulaUnit = match symbol {
                "mm" => LengthUnit::Mm.into(),
                "cm" => LengthUnit::Cm.into(),
                "m" => LengthUnit::M.into(),
                "in" => LengthUnit::In.into(),
                "deg" => AngleUnit::Deg.into(),
                "rad" => AngleUnit::Rad.into(),
                _ => return Err(invalid("Unknown formula unit")),
            };
            let powers = unit.dimension().powers();
            quantity.powers = std::array::from_fn(|i| quantity.powers[i] + powers[i]);
            quantity.value *= unit.scale();
        }
        if !quantity.value.is_finite() {
            return Err(invalid("Formula operand must be finite"));
        }
        Ok(quantity)
    }

    fn number(&mut self) -> Result<f64> {
        let bytes = self.rest.as_bytes();
        let mut end = bytes
            .iter()
            .take_while(|b| b.is_ascii_digit() || **b == b'.')
            .count();
        if matches!(bytes.get(end), Some(b'e' | b'E')) {
            end += 1;
            if matches!(bytes.get(end), Some(b'+' | b'-')) {
                end += 1;
            }
            end += bytes[end..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count();
        }
        let (token, rest) = self.rest.split_at(end);
        self.rest = rest;
        token
            .parse()
            .map_err(|_| invalid("Expected a number in the formula"))
    }
}

mod expression;
use crate::{
    error::{CoreError, ErrorCode, Result},
    protocol::{
        AngleUnit, EvaluatedFormula, Formula, FormulaDimension, FormulaQuantity, FormulaUnit,
        LengthUnit, SceneUnits,
    },
};
pub(crate) use expression::{Expression, Instruction};

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
    pub(crate) fn dimension(self) -> FormulaDimension {
        match self {
            Self::Length(_) => FormulaDimension::Length,
            Self::Angle(_) => FormulaDimension::Angle,
            Self::Scalar(_) => FormulaDimension::Scalar,
        }
    }

    // The modeling kernel takes millimetres and the extrusion API takes degrees.
    pub(crate) fn scale(self) -> f64 {
        match self {
            Self::Length(LengthUnit::Mm) | Self::Angle(AngleUnit::Deg) => 1.,
            Self::Length(LengthUnit::Cm) => 10.,
            Self::Length(LengthUnit::M) => 1000.,
            Self::Length(LengthUnit::In) => 25.4,
            Self::Angle(AngleUnit::Rad) => 1_f64.to_degrees(),
            Self::Scalar(_) => 1.,
        }
    }
}

impl SceneUnits {
    pub(crate) fn unit(self, dimension: FormulaDimension) -> FormulaUnit {
        match dimension {
            FormulaDimension::Length => self.length.into(),
            FormulaDimension::Angle => self.angle.into(),
            FormulaDimension::Scalar => FormulaUnit::Scalar(crate::protocol::ScalarUnit::Scalar),
        }
    }
}

impl FormulaDimension {
    pub(crate) fn powers(self) -> [i32; 2] {
        match self {
            Self::Length => [1, 0],
            Self::Angle => [0, 1],
            Self::Scalar => [0, 0],
        }
    }
}

pub(crate) struct FormulaEvaluator;

impl FormulaEvaluator {
    pub(crate) fn evaluate_with<U: Copy + Into<FormulaUnit>>(
        input: &Formula<U>,
        scene_unit: U,
        resolve: &mut dyn FnMut(&str) -> Result<Quantity>,
    ) -> Result<EvaluatedFormula<U>> {
        let unit = scene_unit.into();
        let dimension = unit.dimension();
        let (expression, saved_unit) = match input {
            Formula::Number(value) => {
                // Numeric API inputs have always used the kernel's length/angle units.
                let suffix = match dimension {
                    FormulaDimension::Length => "mm",
                    FormulaDimension::Angle => "deg",
                    FormulaDimension::Scalar => "",
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
        let result = parse(&expression, resolve)?;
        let numeric = result.expression.evaluate(&[])?;
        let (base, implicit_unit) = if result.powers == [0, 0] {
            let implicit = saved_unit.unwrap_or(scene_unit);
            (numeric * implicit.into().scale(), Some(implicit))
        } else if result.powers == dimension.powers() {
            (numeric, None)
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
            references: vec![],
        })
    }
}

impl<U: Copy + Into<FormulaUnit>> Formula<U> {
    pub(crate) fn resolve_in_scene(
        &mut self,
        scene: &crate::model::Scene,
        scene_unit: U,
    ) -> Result<f64> {
        if let Self::Number(value) = self {
            return Ok(*value);
        }
        let evaluated = scene.evaluate_formula(self, scene_unit)?;
        let value = evaluated.computed.value * scene_unit.into().scale();
        *self = Self::Evaluated(evaluated);
        Ok(value)
    }
}

// The same expression tree feeds scalar evaluation and sketch equation solving.
pub(crate) struct Quantity {
    pub expression: Expression,
    pub powers: [i32; 2],
}

pub(crate) fn parse(
    source: &str,
    resolve: &mut dyn FnMut(&str) -> Result<Quantity>,
) -> Result<Quantity> {
    Parser {
        rest: source,
        resolve,
    }
    .parse()
}

struct Parser<'a, 'b> {
    rest: &'a str,
    resolve: &'b mut dyn FnMut(&str) -> Result<Quantity>,
}

impl Parser<'_, '_> {
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
                    left.expression = if op == b'+' {
                        left.expression.add(right.expression)
                    } else {
                        left.expression.sub(right.expression)
                    };
                }
                b'*' => {
                    left.expression = left.expression.mul(right.expression);
                    left.powers = std::array::from_fn(|i| left.powers[i] + right.powers[i]);
                }
                _ => {
                    left.expression = left.expression.div(right.expression);
                    left.powers = std::array::from_fn(|i| left.powers[i] - right.powers[i]);
                }
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
        } else if self
            .peek()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        {
            let mut brackets = 0;
            let mut end = 0;
            for (index, c) in self.rest.char_indices() {
                if c == '[' {
                    brackets += 1;
                }
                if c == ']' {
                    brackets -= 1;
                }
                if brackets < 0 {
                    return Err(invalid("Unexpected closing reference bracket"));
                }
                if brackets == 0 && !(c.is_alphanumeric() || matches!(c, '_' | '.' | ']')) {
                    break;
                }
                end = index + c.len_utf8();
            }
            if brackets != 0 {
                return Err(invalid("Unclosed reference bracket"));
            }
            let (name, rest) = self.rest.split_at(end);
            self.rest = rest;
            (self.resolve)(name)?
        } else {
            Quantity {
                expression: Expression::number(self.number()?),
                powers: [0, 0],
            }
        };
        if sign < 0. {
            quantity.expression = quantity.expression.neg();
        }
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
            quantity.expression = quantity.expression.scale(unit.scale());
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

impl crate::model::Scene {
    pub(crate) fn evaluate_formula<U: Copy + Into<FormulaUnit>>(
        &self,
        input: &Formula<U>,
        unit: U,
    ) -> Result<EvaluatedFormula<U>> {
        let saved = match input {
            Formula::Evaluated(e) => e.references.as_slice(),
            _ => &[],
        };
        let mut references = vec![];
        let mut result = FormulaEvaluator::evaluate_with(input, unit, &mut |symbol| {
            let bound = saved
                .iter()
                .find(|r| r.symbol == symbol)
                .map(|r| &r.dimension);
            let found = if let Some(r) = bound {
                self.sketches
                    .get(&r.sketch_id)
                    .and_then(|s| s.dimensions.get(&r.id).map(|d| (s, d)))
            } else {
                self.sketches.values().find_map(|s| {
                    s.dimensions
                        .values()
                        .find(|d| {
                            std::iter::once(s.data.id.as_str())
                                .chain(s.data.name.as_deref())
                                .any(|sketch| {
                                    std::iter::once(d.id.as_str())
                                        .chain(d.parameters.name.as_deref())
                                        .any(|dimension| {
                                            format!("sketches[{sketch}]dimension[{dimension}]")
                                                == symbol
                                        })
                                })
                                || format!("{}{}", s.data.id, d.id) == symbol
                        })
                        .map(|d| (s, d))
                })
            }
            .ok_or_else(|| invalid(&format!("Unknown document dimension {symbol}")))?;
            references.push(crate::protocol::FormulaReference {
                symbol: symbol.to_owned(),
                dimension: found.0.entity_ref(&found.1.id),
            });
            let quantity = &found.1.computed;
            Ok(Quantity {
                expression: Expression::number(quantity.value * quantity.unit.scale()),
                powers: quantity.unit.dimension().powers(),
            })
        })?;
        result.references = references;
        Ok(result)
    }
}

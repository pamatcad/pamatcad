use crate::error::{CoreError, ErrorCode, Result};

#[derive(Debug, Clone)]
pub(crate) enum Expression {
    Constant(f64),
    Variable(usize),
    Unary(u32, Box<Self>),
    Binary(u32, Box<Self>, Box<Self>),
}

#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct Instruction {
    pub op: u32,
    pub index: u32,
    pub value: f64,
}

impl Expression {
    pub fn number(value: f64) -> Self {
        Self::Constant(value)
    }
    pub fn variable(index: usize) -> Self {
        Self::Variable(index)
    }
    pub fn add(self, other: Self) -> Self {
        Self::Binary(2, Box::new(self), Box::new(other))
    }
    pub fn sub(self, other: Self) -> Self {
        Self::Binary(3, Box::new(self), Box::new(other))
    }
    pub fn mul(self, other: Self) -> Self {
        Self::Binary(4, Box::new(self), Box::new(other))
    }
    pub fn div(self, other: Self) -> Self {
        Self::Binary(5, Box::new(self), Box::new(other))
    }
    pub fn sqrt(self) -> Self {
        Self::Unary(6, Box::new(self))
    }
    pub fn sin(self) -> Self {
        Self::Unary(7, Box::new(self))
    }
    pub fn cos(self) -> Self {
        Self::Unary(8, Box::new(self))
    }
    pub fn neg(self) -> Self {
        Self::Unary(9, Box::new(self))
    }
    pub fn atan2(self, other: Self) -> Self {
        Self::Binary(10, Box::new(self), Box::new(other))
    }
    pub fn abs(self) -> Self {
        Self::Unary(11, Box::new(self))
    }
    pub fn square(self) -> Self {
        self.clone().mul(self)
    }
    pub fn scale(self, scale: f64) -> Self {
        self.mul(Self::number(scale))
    }
    pub fn evaluate(&self, values: &[f64]) -> Result<f64> {
        let value = match self {
            Self::Constant(value) => *value,
            Self::Variable(index) => *values.get(*index).ok_or_else(|| {
                CoreError::new(ErrorCode::InvalidParameter, "Unresolved formula variable")
            })?,
            Self::Unary(op, value) => {
                let value = value.evaluate(values)?;
                match op {
                    6 => value.sqrt(),
                    7 => value.sin(),
                    8 => value.cos(),
                    9 => -value,
                    11 => value.abs(),
                    _ => unreachable!(),
                }
            }
            Self::Binary(op, a, b) => {
                let a = a.evaluate(values)?;
                let b = b.evaluate(values)?;
                match op {
                    2 => a + b,
                    3 => a - b,
                    4 => a * b,
                    5 => {
                        if b == 0. {
                            return Err(CoreError::new(
                                ErrorCode::InvalidParameter,
                                "Division by zero",
                            ));
                        }
                        a / b
                    }
                    10 => a.atan2(b),
                    _ => unreachable!(),
                }
            }
        };
        if value.is_finite() {
            Ok(value)
        } else {
            Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Formula result must be finite",
            ))
        }
    }
    pub fn instructions(&self, output: &mut Vec<Instruction>) {
        let instruction = match self {
            Self::Constant(value) => Instruction {
                op: 0,
                index: 0,
                value: *value,
            },
            Self::Variable(index) => Instruction {
                op: 1,
                index: *index as u32,
                value: 0.,
            },
            Self::Unary(op, a) => {
                a.instructions(output);
                Instruction {
                    op: *op,
                    index: 0,
                    value: 0.,
                }
            }
            Self::Binary(op, a, b) => {
                a.instructions(output);
                b.instructions(output);
                Instruction {
                    op: *op,
                    index: 0,
                    value: 0.,
                }
            }
        };
        output.push(instruction);
    }
}

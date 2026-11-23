use crate::protocol::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SketchEntityRef {
    pub scene_id: String,
    pub sketch_id: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum SketchGeometry {
    Point {
        position: [f64; 2],
    },
    Line {
        from: String,
        to: String,
    },
    Circle {
        center: String,
        radius: f64,
    },
    Arc {
        center: String,
        from: String,
        to: String,
        radius: f64,
        start: f64,
        end: f64,
    },
    Ellipse {
        center: String,
        major: f64,
        minor: f64,
        angle: f64,
    },
    Spline {
        points: Vec<String>,
        degree: usize,
        knots: Vec<f64>,
        weights: Vec<f64>,
        closed: bool,
        fit: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SketchEntity {
    pub reference: SketchEntityRef,
    pub geometry: SketchGeometry,
    pub construction: bool,
    pub projected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConstraintKind {
    Coincident,
    PointOnCurve,
    Fix,
    Equal,
    Concentric,
    Midpoint,
    Parallel,
    Perpendicular,
    Tangent,
    Horizontal,
    Vertical,
    Symmetric,
    Collinear,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConstraintParameters {
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub points: Vec<SketchEntityRef>,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub curves: Vec<SketchEntityRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SketchConstraint {
    pub id: String,
    pub kind: ConstraintKind,
    pub parameters: ConstraintParameters,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DimensionKind {
    Length,
    Distance,
    HorizontalDistance,
    VerticalDistance,
    Radius,
    Diameter,
    MajorRadius,
    MinorRadius,
    Angle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DimensionMode {
    Driving,
    Driven,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DimensionParameters {
    #[ts(optional)]
    pub line: Option<SketchEntityRef>,
    #[ts(optional)]
    pub curve: Option<SketchEntityRef>,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub points: Vec<SketchEntityRef>,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub curves: Vec<SketchEntityRef>,
    #[ts(optional)]
    pub name: Option<String>,
    #[ts(optional)]
    pub value: Option<Formula<FormulaUnit>>,
    pub mode: DimensionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SketchDimension {
    pub id: String,
    pub kind: DimensionKind,
    pub parameters: DimensionParameters,
    pub computed: FormulaQuantity<FormulaUnit>,
    pub dependencies: Vec<SketchEntityRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SketchSolveState {
    Constrained,
    Underconstrained,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SketchEntityFreedom {
    pub entity: SketchEntityRef,
    pub degrees_of_freedom: usize,
    pub unconstrained_degrees_of_freedom: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SketchSolveStatus {
    pub state: SketchSolveState,
    pub degrees_of_freedom: usize,
    pub movable_entities: Vec<SketchEntityRef>,
    pub entities: Vec<SketchEntityFreedom>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SketchState {
    pub sketch: SketchData,
    pub frame: PlaneFrame,
    pub entities: Vec<SketchEntity>,
    pub constraints: Vec<SketchConstraint>,
    pub dimensions: Vec<SketchDimension>,
    pub status: SketchSolveStatus,
    pub revision: u64,
    pub auto_recompute: bool,
    pub projections: Vec<SketchProjection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VertexRef {
    pub scene_id: String,
    pub body_id: String,
    pub vertex_id: usize,
    pub revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "reference", rename_all = "camelCase")]
pub enum ProjectionSource {
    Face(FaceRef),
    Edge(EdgeRef),
    Vertex(VertexRef),
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SketchProjection {
    pub id: String,
    pub source: ProjectionSource,
    pub entities: Vec<SketchEntityRef>,
    pub warning: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectGeometry {
    pub sketch: SketchRef,
    pub source: ProjectionSource,
    #[ts(optional)]
    pub id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct UpdateSketchSupport {
    pub sketch: SketchRef,
    pub plane: SketchSupport,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TransformSketchGeometry {
    #[ts(optional)]
    pub preview: Option<bool>,
    pub sketch: SketchRef,
    pub entities: Vec<SketchEntityRef>,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub pivot: [f64; 2],
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub translation: [f64; 2],
    #[ts(optional)]
    pub angle: Option<Formula<AngleUnit>>,
    #[ts(optional)]
    pub scale: Option<Formula<FormulaUnit>>,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub copy: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SetConstruction {
    pub sketch: SketchRef,
    pub entities: Vec<SketchEntityRef>,
    pub construction: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum SketchCurveEdit {
    Split,
    Offset {
        distance1: Formula<LengthUnit>,
        #[ts(optional)]
        distance2: Option<Formula<LengthUnit>>,
    },
    Rounding {
        radius: Formula<LengthUnit>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ModifySketchCurves {
    #[ts(optional)]
    pub preview: Option<bool>,
    pub sketch: SketchRef,
    pub curves: Vec<SketchEntityRef>,
    pub operation: SketchCurveEdit,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SketchEditResult {
    pub created: Vec<SketchEntityRef>,
    pub removed: Vec<SketchEntityRef>,
    pub removed_constraints: Vec<String>,
    pub removed_dimensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SketchFind {
    pub scene_id: String,
    #[ts(optional)]
    pub id: Option<String>,
    #[ts(optional)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SketchSettings {
    pub sketch: SketchRef,
    #[ts(optional)]
    pub name: Option<String>,
    #[ts(optional)]
    pub auto_recompute: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AddConstraint {
    pub sketch: SketchRef,
    pub kind: ConstraintKind,
    pub parameters: ConstraintParameters,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AddDimension {
    pub sketch: SketchRef,
    pub kind: DimensionKind,
    pub parameters: DimensionParameters,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct UpdateDimension {
    pub sketch: SketchRef,
    pub id: String,
    #[ts(optional)]
    pub value: Option<Formula<FormulaUnit>>,
    #[ts(optional)]
    pub mode: Option<DimensionMode>,
    #[ts(optional)]
    pub name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RemoveSketchItems {
    pub sketch: SketchRef,
    pub ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct DragSketchPoint {
    pub sketch: SketchRef,
    pub point: SketchEntityRef,
    pub position: [f64; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(untagged, deny_unknown_fields)]
pub enum DragSketchGeometry {
    Point(DragSketchPoint),
    Line {
        sketch: SketchRef,
        line: SketchEntityRef,
        from: [f64; 2],
        to: [f64; 2],
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PointParameters {
    pub position: [f64; 2],
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub construction: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct LineParameters {
    pub from: [f64; 2],
    pub to: [f64; 2],
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub construction: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ArcParameters {
    pub center: [f64; 2],
    pub radius: f64,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub construction: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct EllipseParameters {
    pub center: [f64; 2],
    pub major: f64,
    pub minor: f64,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub angle: f64,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub construction: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SlotParameters {
    pub from: [f64; 2],
    pub to: [f64; 2],
    pub radius: f64,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub construction: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplineParameters {
    pub points: Vec<[f64; 2]>,
    #[ts(optional)]
    pub degree: Option<usize>,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub fit: bool,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub closed: bool,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub construction: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TextHorizontalAlign {
    #[default]
    Left,
    Center,
    Right,
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TextVerticalAlign {
    #[default]
    Baseline,
    Bottom,
    Middle,
    Top,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextParameters {
    pub text: String,
    pub origin: [f64; 2],
    pub size: Formula<LengthUnit>,
    #[ts(optional)]
    pub font_base64: Option<String>,
    #[ts(optional)]
    pub weight: Option<f32>,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub horizontal: TextHorizontalAlign,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub vertical: TextVerticalAlign,
    #[ts(optional)]
    pub guide: Option<SketchEntityRef>,
    #[serde(default)]
    #[ts(optional, as = "Option<_>")]
    pub construction: bool,
}

pub fn declarations() -> Vec<String> {
    vec![
        SketchEntityRef::decl(),
        SketchGeometry::decl(),
        SketchEntity::decl(),
        ConstraintKind::decl(),
        ConstraintParameters::decl(),
        SketchConstraint::decl(),
        DimensionKind::decl(),
        DimensionMode::decl(),
        DimensionParameters::decl(),
        SketchDimension::decl(),
        SketchSolveState::decl(),
        SketchSolveStatus::decl(),
        SketchEntityFreedom::decl(),
        SketchState::decl(),
        SketchFind::decl(),
        SketchSettings::decl(),
        AddConstraint::decl(),
        AddDimension::decl(),
        UpdateDimension::decl(),
        RemoveSketchItems::decl(),
        DragSketchPoint::decl(),
        DragSketchGeometry::decl(),
        PointParameters::decl(),
        LineParameters::decl(),
        ArcParameters::decl(),
        EllipseParameters::decl(),
        SlotParameters::decl(),
        SplineParameters::decl(),
        VertexRef::decl(),
        ProjectionSource::decl(),
        SketchProjection::decl(),
        ProjectGeometry::decl(),
        UpdateSketchSupport::decl(),
        TransformSketchGeometry::decl(),
        SetConstruction::decl(),
        TextHorizontalAlign::decl(),
        TextVerticalAlign::decl(),
        TextParameters::decl(),
        SketchCurveEdit::decl(),
        ModifySketchCurves::decl(),
        SketchEditResult::decl(),
    ]
}

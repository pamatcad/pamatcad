use crate::error::{CoreError, ErrorCode};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Plane {
    Xy,
    Xz,
    Yz,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaneRef {
    pub scene_id: String,
    pub id: String,
    pub plane: Plane,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SketchRef {
    pub scene_id: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineRef {
    pub scene_id: String,
    pub sketch_id: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegionRef {
    pub scene_id: String,
    pub sketch_id: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BodyRef {
    pub scene_id: String,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FaceRole {
    EndCap,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct FaceOrigin {
    pub feature: String,
    pub role: FaceRole,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FaceRef {
    pub scene_id: String,
    pub body_id: String,
    pub origin: FaceOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum SketchSupport {
    Plane(PlaneRef),
    Face(FaceRef),
}

impl SketchSupport {
    pub fn scene_id(&self) -> &str {
        match self {
            Self::Plane(p) => &p.scene_id,
            Self::Face(f) => &f.scene_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Planes {
    pub xy: PlaneRef,
    pub xz: PlaneRef,
    pub yz: PlaneRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct BuiltinConstruction {
    pub planes: Planes,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Construction {
    pub builtin: BuiltinConstruction,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SceneData {
    pub id: String,
    pub name: Option<String>,
    pub construction: Construction,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SketchData {
    pub id: String,
    pub scene_id: String,
    pub plane: SketchSupport,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RectangleData {
    pub id: String,
    pub lines: Vec<LineRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RectangleParameters {
    pub from: [f64; 2],
    pub to: [f64; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct CircleParameters {
    pub center: [f64; 2],
    pub diameter: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CircleData {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum PrimitiveData {
    Rectangle(RectangleData),
    Circle(CircleData),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    content = "parameters",
    rename_all = "lowercase",
    deny_unknown_fields
)]
pub enum Primitive {
    Rectangle(RectangleParameters),
    Circle(CircleParameters),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtrudeMode {
    NewBody,
    Cut,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ExtrudeParameters {
    pub length: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mode: Option<ExtrudeMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ExtrudeInputs {
    pub profile: RegionRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub targets: Option<Vec<BodyRef>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Operation {
    Extrude {
        inputs: ExtrudeInputs,
        parameters: ExtrudeParameters,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExtrudeFeature {
    pub id: String,
    pub operation: Operation,
    pub new_solids: Vec<BodyRef>,
    pub affected_solids: Vec<BodyRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub enum VolumeUnit {
    #[serde(rename = "mm3")]
    CubicMillimetres,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Volume {
    pub value: f64,
    pub unit: VolumeUnit,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct BodyProperties {
    pub volume: Volume,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct CreateScene {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct CreateSketch {
    pub plane: SketchSupport,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AddPrimitive {
    pub sketch: SketchRef,
    pub primitive: Primitive,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SketchQuery {
    pub sketch: SketchRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Extrude {
    pub profile: RegionRef,
    pub parameters: ExtrudeParameters,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub targets: Option<Vec<BodyRef>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct BodyQuery {
    pub body: BodyRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct FaceQuery {
    pub body: BodyRef,
    pub origin: FaceOrigin,
}

// Each entry defines the request and response types for the same method.
macro_rules! api {
    ($($variant:ident($input:ty) -> $output:ty = $method:literal),+ $(,)?) => {
        #[derive(Debug, Deserialize, TS)]
        #[serde(tag = "method", content = "params", deny_unknown_fields)]
        pub enum Request { $(#[serde(rename = $method)] $variant($input)),+ }

        #[derive(Debug, Serialize, TS)]
        #[serde(tag = "method", content = "value")]
        pub enum Response { $(#[serde(rename = $method)] $variant($output)),+ }

        pub const METHODS: &[&str] = &[$($method),+];
    };
}

api! {
    SceneCreate(CreateScene) -> SceneData = "scene.create",
    SketchCreate(CreateSketch) -> SketchData = "sketch.create",
    PrimitiveAdd(AddPrimitive) -> PrimitiveData = "sketch.primitives.add",
    SketchComplete(SketchQuery) -> SketchData = "sketch.complete",
    RegionOnly(SketchQuery) -> RegionRef = "sketch.regions.only",
    SolidExtrude(Extrude) -> ExtrudeFeature = "solid.extrude",
    BodyGet(BodyQuery) -> BodyRef = "body.get",
    FaceOnly(FaceQuery) -> FaceRef = "body.faces.only",
    BodyProperties(BodyQuery) -> BodyProperties = "body.properties",
}

pub fn typescript() -> String {
    let declarations = [
        Plane::decl(),
        PlaneRef::decl(),
        SketchRef::decl(),
        LineRef::decl(),
        RegionRef::decl(),
        BodyRef::decl(),
        FaceRole::decl(),
        FaceOrigin::decl(),
        FaceRef::decl(),
        FaceQuery::decl(),
        SketchSupport::decl(),
        Planes::decl(),
        BuiltinConstruction::decl(),
        Construction::decl(),
        SceneData::decl(),
        SketchData::decl(),
        RectangleData::decl(),
        RectangleParameters::decl(),
        CircleParameters::decl(),
        CircleData::decl(),
        PrimitiveData::decl(),
        Primitive::decl(),
        ExtrudeMode::decl(),
        ExtrudeParameters::decl(),
        ExtrudeInputs::decl(),
        Operation::decl(),
        ExtrudeFeature::decl(),
        VolumeUnit::decl(),
        Volume::decl(),
        BodyProperties::decl(),
        CreateScene::decl(),
        CreateSketch::decl(),
        AddPrimitive::decl(),
        SketchQuery::decl(),
        Extrude::decl(),
        BodyQuery::decl(),
        Request::decl(),
        Response::decl(),
        ErrorCode::decl(),
        CoreError::decl(),
    ];
    let mut output = String::from("// Generated by pamatcad bindings. Do not edit.\n\n");
    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push('\n');
    }
    output
}

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged, rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum FaceRef {
    Origin {
        scene_id: String,
        body_id: String,
        origin: FaceOrigin,
    },
    Selected {
        scene_id: String,
        body_id: String,
        face_id: usize,
    },
}

impl FaceRef {
    pub(crate) fn scene_id(&self) -> &str {
        match self {
            Self::Origin { scene_id, .. } | Self::Selected { scene_id, .. } => scene_id,
        }
    }
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
            Self::Face(face) => face.scene_id(),
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
    Join,
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
#[serde(untagged)]
pub enum Profiles {
    Single(RegionRef),
    Multiple(Vec<RegionRef>),
    Face(FaceRef),
    Faces(Vec<FaceRef>),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum ProfileRef {
    Region(RegionRef),
    Face(FaceRef),
}

impl ProfileRef {
    pub(crate) fn scene_id(&self) -> &str {
        match self {
            Self::Region(r) => &r.scene_id,
            Self::Face(f) => f.scene_id(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(tag = "role", rename_all = "camelCase", deny_unknown_fields)]
pub enum ExtrudeFaceSelector {
    StartCap,
    EndCap,
    SideFaces {
        #[ts(optional)]
        edge: Option<LineRef>,
    },
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ExtrudeFaceQuery {
    pub feature: String,
    pub profile: ProfileRef,
    pub selector: ExtrudeFaceSelector,
}

impl Profiles {
    pub fn regions(&self) -> &[RegionRef] {
        match self {
            Self::Single(region) => std::slice::from_ref(region),
            Self::Multiple(regions) => regions,
            Self::Face(_) | Self::Faces(_) => &[],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ExtrudeInputs {
    pub profile: Profiles,
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
pub struct Feature {
    pub id: String,
    pub operation: Operation,
    pub new_solids: Vec<BodyRef>,
    pub affected_solids: Vec<BodyRef>,
    #[serde(default)]
    pub removed_solids: Vec<BodyRef>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FeaturePreview {
    pub operation: Operation,
    pub new_solids: Vec<BodyProperties>,
    pub affected_solids: Vec<BodyRef>,
    pub removed_solids: Vec<BodyRef>,
}

#[derive(Debug, Serialize, TS)]
#[serde(untagged)]
pub enum FeatureResult {
    Feature(Feature),
    Preview(FeaturePreview),
}

// Existing Rust and SDK clients can keep their operation-specific type names.
pub type ExtrudeFeature = Feature;
pub type ExtrudePreview = FeaturePreview;
pub type ExtrudeResult = FeatureResult;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TimelineEntry {
    Sketch { id: String },
    Extrude { id: String },
}

impl Feature {
    pub(crate) fn timeline_entry(&self) -> TimelineEntry {
        match self.operation {
            Operation::Extrude { .. } => TimelineEntry::Extrude {
                id: self.id.clone(),
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneQuery {
    pub scene_id: String,
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
    #[ts(optional)]
    pub preview: Option<bool>,
    pub profile: Profiles,
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
#[serde(untagged, deny_unknown_fields)]
pub enum FaceQuery {
    Origin { body: BodyRef, origin: FaceOrigin },
    Normal { body: BodyRef, normal: [f64; 3] },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ShapeFormat {
    Step,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Jpeg,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Projection {
    Orthographic,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum CameraFit {
    Bounds,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CameraOptions {
    #[ts(optional)]
    pub projection: Option<Projection>,
    #[ts(optional)]
    pub from_direction: Option<[f64; 3]>,
    #[ts(optional)]
    pub target: Option<[f64; 3]>,
    #[ts(optional)]
    pub up: Option<[f64; 3]>,
    #[ts(optional)]
    pub fit: Option<CameraFit>,
    #[ts(optional)]
    pub padding_px: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportScene {
    pub scene_id: String,
    pub format: ShapeFormat,
    #[ts(optional)]
    pub bodies: Option<Vec<BodyRef>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureScene {
    pub scene_id: String,
    pub format: ImageFormat,
    #[ts(optional)]
    pub bodies: Option<Vec<BodyRef>>,
    #[ts(optional)]
    pub width: Option<u32>,
    #[ts(optional)]
    pub height: Option<u32>,
    #[ts(optional)]
    pub camera: Option<CameraOptions>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EncodedFile {
    pub media_type: String,
    pub base64: String,
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
    SceneExport(ExportScene) -> EncodedFile = "scene.export",
    SceneCapture(CaptureScene) -> EncodedFile = "scene.capture",
    SketchCreate(CreateSketch) -> SketchData = "sketch.create",
    PrimitiveAdd(AddPrimitive) -> PrimitiveData = "sketch.primitives.add",
    SketchComplete(SketchQuery) -> SketchData = "sketch.complete",
    RegionOnly(SketchQuery) -> RegionRef = "sketch.regions.only",
    RegionsAll(SketchQuery) -> Vec<RegionRef> = "sketch.regions.all",
    TimelineList(SceneQuery) -> Vec<TimelineEntry> = "scene.timeline.list",
    SolidExtrude(Extrude) -> ExtrudeResult = "solid.extrude",
    ExtrudeFacesAll(ExtrudeFaceQuery) -> Vec<FaceRef> = "solid.extrude.faces.all",
    ExtrudeFaceOnly(ExtrudeFaceQuery) -> FaceRef = "solid.extrude.faces.only",
    BodiesAll(SceneQuery) -> Vec<BodyRef> = "scene.bodies.all",
    BodyGet(BodyQuery) -> BodyRef = "body.get",
    FaceOnly(FaceQuery) -> FaceRef = "body.faces.only",
    FacesAll(BodyQuery) -> Vec<FaceRef> = "body.faces.all",
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
        Profiles::decl(),
        ProfileRef::decl(),
        ExtrudeFaceSelector::decl(),
        ExtrudeFaceQuery::decl(),
        ExtrudeInputs::decl(),
        Operation::decl(),
        Feature::decl(),
        FeaturePreview::decl(),
        FeatureResult::decl(),
        TimelineEntry::decl(),
        SceneQuery::decl(),
        VolumeUnit::decl(),
        Volume::decl(),
        BodyProperties::decl(),
        ShapeFormat::decl(),
        ImageFormat::decl(),
        Projection::decl(),
        CameraFit::decl(),
        CameraOptions::decl(),
        ExportScene::decl(),
        CaptureScene::decl(),
        EncodedFile::decl(),
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
    output.push_str(concat!(
        "export type ExtrudeFeature = Feature & { operation: Extract<Operation, { type: \"extrude\" }> };\n",
        "export type ExtrudePreview = FeaturePreview & { operation: ExtrudeFeature[\"operation\"] };\n",
        "export type ExtrudeResult = ExtrudeFeature | ExtrudePreview;\n",
    ));
    output
}

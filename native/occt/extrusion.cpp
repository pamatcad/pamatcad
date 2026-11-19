#include "bridge_internal.hxx"
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepBndLib.hxx>
#include <BRepOffsetAPI_DraftAngle.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <Bnd_Box.hxx>
#include <Precision.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <gp_Circ.hxx>
#include <gp_Pln.hxx>
#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <stdexcept>
#include <utility>

namespace {
using ZRange = std::pair<double, double>;
ZRange axial_bounds(const TopoDS_Shape& shape, const gp_Pnt& origin, const gp_Dir& axis) {
    gp_Trsf frame;
    frame.SetTransformation(gp_Ax3(origin, axis));
    Bnd_Box box;
    BRepBndLib::AddOptimal(shape.Moved(TopLoc_Location(frame)), box, false, false);
    if (box.IsVoid() || box.IsOpen()) throw std::runtime_error("Expected finite extrusion bounds");
    return {box.CornerMin().Z(), box.CornerMax().Z()};
}

PamatShape side_prism(const TopoDS_Face& face, const std::vector<TopoDS_Edge>& edges,
                      const gp_Dir& direction, double length, double taper, const gp_Pnt& start) {
    BRepPrimAPI_MakePrism prism(face, gp_Vec(direction) * length, true);
    if (!prism.IsDone()) throw std::runtime_error("Could not extrude profile");
    PamatShape result;
    result.value = prism.Shape();
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(result.value, TopAbs_FACE, faces);
    auto keep = [&](TopTools_IndexedMapOfShape& slot, const TopoDS_Shape& generated) {
        slot.Add(faces.FindKey(faces.FindIndex(generated)));
    };
    keep(result.named_faces.emplace_back(), prism.LastShape());
    keep(result.named_faces.emplace_back(), prism.FirstShape());
    for (const auto& edge : edges) {
        auto& side = result.named_faces.emplace_back();
        for (const auto& generated : prism.Generated(edge))
            if (generated.ShapeType() == TopAbs_FACE) keep(side, generated);
    }
    if (taper == 0) return result;
    BRepOffsetAPI_DraftAngle draft(result.value);
    const gp_Pln neutral(start, direction);
    for (size_t slot = 2; slot < result.named_faces.size(); ++slot) {
        for (const auto& side : result.named_faces[slot]) {
            if (draft.ModifiedFaces().Contains(side)) continue;
            draft.Add(TopoDS::Face(side), direction, -taper, neutral);
            if (!draft.AddDone()) throw std::runtime_error("Cannot taper this profile boundary");
        }
    }
    draft.Build();
    if (!draft.IsDone()) throw std::runtime_error("Could not construct the tapered extrusion");
    result.value = draft.Shape();
    faces.Clear();
    TopExp::MapShapes(result.value, TopAbs_FACE, faces);
    for (auto& slot : result.named_faces) {
        TopTools_IndexedMapOfShape updated;
        for (const auto& original : slot) {
            const auto& modified = draft.ModifiedShape(original);
            const int index = faces.FindIndex(modified);
            if (!index) throw std::runtime_error("Taper lost a generating face");
            updated.Add(faces.FindKey(index));
        }
        slot = std::move(updated);
    }
    return result;
}

template<class Operation>
TopoDS_Shape boolean_result(Operation& operation) {
    operation.SetNonDestructive(true);
    operation.Build();
    if (!operation.IsDone() || operation.HasErrors()) throw std::runtime_error("Extrusion intersection failed");
    return operation.Shape();
}

double object_length(const TopoDS_Face& face, const std::vector<TopoDS_Edge>& edges,
                     const gp_Pnt& start, const gp_Dir& dir, const PamatExtrudeSide& side) {
    if (!side.target) return std::abs(side.length);
    const auto& body = side.target->value;
    auto [lo, hi] = axial_bounds(body, start, dir);
    const double tol = Precision::Confusion();
    if (hi <= tol) throw std::invalid_argument("Limiting body is behind the extrusion");
    if (side.extent == 1) return std::max(0., lo);
    if (side.extent == 4) return hi;

    // Clip the full extrusion to the selected body. Its first occupied station is touch.
    // For containment, project all solid parts of the complementary material onto the
    // extrusion axis. A station can contain the entire cap only outside these intervals
    // (or at their boundaries). This also handles voids and nonmonotonic cross sections.
    const auto envelope = side_prism(face, edges, dir, hi, side.taper, start);
    NCollection_List<TopoDS_Shape> tools, arguments;
    arguments.Append(envelope.value);
    tools.Append(body);
    if (side.extent == 2) {
        BRepAlgoAPI_Common common;
        common.SetArguments(arguments);
        common.SetTools(tools);
        const auto inside = boolean_result(common);
        double first = TopExp_Explorer(inside, TopAbs_SOLID).More()
                       ? axial_bounds(inside, start, dir).first
                       : std::numeric_limits<double>::infinity();
        // Section includes point or edge contacts with no shared solid material.
        BRepAlgoAPI_Section section(envelope.value, body, false);
        const auto contact = boolean_result(section);
        if (TopExp_Explorer(contact, TopAbs_VERTEX).More()) {
            first = std::min(first, axial_bounds(contact, start, dir).first);
        }
        if (std::isfinite(first)) return std::max(0., first);
        throw std::invalid_argument("The extrusion does not touch the limiting body");
    }
    BRepAlgoAPI_Cut cut;
    cut.SetArguments(arguments); cut.SetTools(tools);
    auto outside = boolean_result(cut);
    std::vector<double> stations{std::max(0.,lo), hi};
    for (TopExp_Explorer it(outside, TopAbs_SOLID); it.More(); it.Next()) {
        auto range = axial_bounds(it.Current(), start, dir);
        stations.push_back(range.first);
        stations.push_back(range.second);
    }
    std::sort(stations.begin(), stations.end());
    for (double height : stations) {
        if (height < -tol || height > hi + tol) continue;
        TopoDS_Shape cap = face;
        if (height > tol) {
            auto probe = side_prism(face, edges, dir, height, side.taper, start);
            cap = probe.named_faces.front().FindKey(1);
        }
        NCollection_List<TopoDS_Shape> caps;
        caps.Append(cap);
        BRepAlgoAPI_Cut remainder;
        remainder.SetArguments(caps); remainder.SetTools(tools);
        auto uncovered = boolean_result(remainder);
        if (!TopExp_Explorer(uncovered, TopAbs_FACE).More()) return std::max(0., height);
    }
    throw std::invalid_argument("The entire extrusion cap cannot fit inside the limiting body");
}

void extrude_face(TopoDS_Face face, std::vector<TopoDS_Edge> edges,
                  const PamatExtrusion& options, PamatShape** output) {
    const gp_Dir normal(options.normal[0], options.normal[1], options.normal[2]);
    gp_Pnt start(options.origin[0], options.origin[1], options.origin[2]);
    const gp_Vec translation = gp_Vec(normal) * options.offset;
    start.Translate(translation);
    if (options.offset != 0) {
        gp_Trsf trsf;
        trsf.SetTranslation(translation);
        TopLoc_Location shift(trsf);
        face.Move(shift);
        for (auto& edge : edges) edge.Move(shift);
    }
    auto make = [&](const PamatExtrudeSide& side) {
        const auto dir = side.length < 0 ? normal.Reversed() : normal;
        double length = object_length(face, edges, start, dir, side);
        if (!std::isfinite(length) || length <= Precision::Confusion())
            throw std::invalid_argument("Extrusion has no forward length");
        return side_prism(face, edges, dir, length, side.taper, start);
    };
    auto result = std::make_unique<PamatShape>(make(options.sides[0]));
    if (options.two_sides) {
        auto other = make(options.sides[1]);
        BRepAlgoAPI_Fuse fuse;
        NCollection_List<TopoDS_Shape> args, tools;
        args.Append(result->value); tools.Append(other.value);
        fuse.SetArguments(args); fuse.SetTools(tools);
        auto joined = boolean_result(fuse);
        TopExp_Explorer solids(joined, TopAbs_SOLID);
        if (!solids.More()) throw std::runtime_error("Two sides did not form a solid");
        result->value = solids.Current();
        solids.Next();
        if (solids.More()) throw std::runtime_error("Two sides produced multiple solids");
        TopTools_IndexedMapOfShape boundary;
        TopExp::MapShapes(result->value, TopAbs_FACE, boundary);
        std::vector<TopTools_IndexedMapOfShape> slots;
        auto append = [&](const TopTools_IndexedMapOfShape& sources) {
            auto& slot = slots.emplace_back();
            auto keep = [&](const TopoDS_Shape& candidate) {
                const int i = boundary.FindIndex(candidate);
                if (i) slot.Add(boundary.FindKey(i));
            };
            for (const auto& source : sources) {
                keep(source);
                for (const auto& next : fuse.Modified(source)) keep(next);
            }
        };
        // End 1, end 2, side-1 edges, side-2 edges. There is no internal start cap.
        append(result->named_faces[0]);
        append(other.named_faces[0]);
        for (size_t i=2; i<result->named_faces.size(); ++i) append(result->named_faces[i]);
        for (size_t i=2; i<other.named_faces.size(); ++i) append(other.named_faces[i]);
        result->named_faces = std::move(slots);
    }
    validated_volume(result->value);
    result->index_faces();
    *output = result.release();
}
}

extern "C" int pamat_axial_bounds(const PamatShape* body, size_t face_id, const double* origin,
                                  const double* direction, double* bounds, char* error, size_t error_size) {
    return checked([&] {
        const auto& shape = face_id == std::numeric_limits<size_t>::max() ? body->value
                                         : body->named_faces.at(face_id).FindKey(1);
        auto range = axial_bounds(shape, gp_Pnt(origin[0],origin[1],origin[2]),
                                  gp_Dir(direction[0],direction[1],direction[2]));
        bounds[0] = range.first; bounds[1] = range.second;
    }, error, error_size);
}

extern "C" int pamat_extrude_face(const PamatShape* body, size_t face_id, const PamatExtrusion* options,
                                  PamatShape** output, char* error, size_t error_size) {
    if (output) *output = nullptr;
    return checked([&] {
        if (!body || !options || !output) throw std::runtime_error("Invalid extrusion arguments");
        const auto& faces = body->named_faces.at(face_id);
        if (faces.Extent() != 1) throw std::runtime_error("Extrusion profile must resolve to one face");
        const auto& face = TopoDS::Face(faces.FindKey(1));
        TopTools_IndexedMapOfShape boundary;
        TopExp::MapShapes(face, TopAbs_EDGE, boundary);
        std::vector<TopoDS_Edge> edges;
        for (const auto& edge : boundary) edges.push_back(TopoDS::Edge(edge));
        extrude_face(face, edges, *options, output);
    }, error, error_size);
}

extern "C" int pamat_extrude(const double* points, size_t count, const PamatExtrusion* options,
                             PamatShape** output, char* error, size_t error_size) {
    if (output) *output = nullptr;
    return checked([&] {
        if (!points || !options || !output || count < 3) {
            throw std::runtime_error("Invalid extrusion arguments");
        }
        BRepBuilderAPI_MakePolygon polygon;
        std::vector<TopoDS_Edge> edges;
        for (size_t i = 0; i < count; ++i) {
            polygon.Add(gp_Pnt(points[3 * i], points[3 * i + 1], points[3 * i + 2]));
            if (i > 0) edges.push_back(polygon.Edge());
        }
        polygon.Close();
        if (!polygon.IsDone()) throw std::runtime_error("Could not construct the profile wire");
        edges.push_back(polygon.Edge());
        BRepBuilderAPI_MakeFace face(polygon.Wire(), true);
        if (!face.IsDone()) throw std::runtime_error("Could not construct the profile face");
        extrude_face(face.Face(), edges, *options, output);
    }, error, error_size);
}

extern "C" int pamat_extrude_circle(const double* center, double radius, const PamatExtrusion* options, PamatShape** output, char* error, size_t error_size) {
    if (output) *output = nullptr;
    return checked([&] {
        if (!center || !options || !output) throw std::runtime_error("Invalid circle arguments");
        const gp_Ax2 axes(gp_Pnt(center[0], center[1], center[2]), gp_Dir(options->normal[0], options->normal[1], options->normal[2]));
        BRepBuilderAPI_MakeEdge edge(gp_Circ(axes, radius));
        BRepBuilderAPI_MakeWire wire(edge.Edge());
        BRepBuilderAPI_MakeFace face(wire.Wire(), true);
        if (!face.IsDone()) throw std::runtime_error("Could not construct the circular profile");
        extrude_face(face.Face(), {edge.Edge()}, *options, output);
    }, error, error_size);
}


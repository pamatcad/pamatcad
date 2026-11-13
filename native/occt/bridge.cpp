#include "bridge_internal.hxx"
#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <gp_Circ.hxx>
#include <gp_Pln.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <GProp_GProps.hxx>
#include <Standard_Failure.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>
#include <cmath>
#include <cstdio>
#include <exception>
#include <limits>
#include <memory>
#include <stdexcept>
#include <vector>
#include <Precision.hxx>

static double volume(const TopoDS_Shape& shape) {
    GProp_GProps properties;
    BRepGProp::VolumeProperties(shape, properties, true, false, false);
    const double value = properties.Mass();
    if (!std::isfinite(value) || value <= 0) {
        throw std::runtime_error("Solid has no positive finite volume");
    }
    return value;
}

double validated_volume(const TopoDS_Shape& solid) {
    if (solid.IsNull() || solid.ShapeType() != TopAbs_SOLID ||
        !BRepCheck_Analyzer(solid, true).IsValid()) {
        throw std::runtime_error("Operation did not produce a valid solid");
    }
    return volume(solid);
}

static void extrude_face(const TopoDS_Face& face, const std::vector<TopoDS_Edge>& edges,
                         const double* direction, PamatShape** output,
                         bool copy_profile = false) {
    BRepPrimAPI_MakePrism prism(face, gp_Vec(direction[0], direction[1], direction[2]), copy_profile);
    if (!prism.IsDone()) throw std::runtime_error("Could not extrude the profile");
    auto shape = std::make_unique<PamatShape>();
    shape->value = prism.Shape();
    validated_volume(shape->value);
    // Use the face's outward orientation in the finished solid.
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(shape->value, TopAbs_FACE, faces);
    const auto keep = [&](TopTools_IndexedMapOfShape& slot, const TopoDS_Shape& generated) {
        const int index = faces.FindIndex(generated);
        if (!index) throw std::runtime_error("Generated prism face is missing from its solid");
        slot.Add(faces.FindKey(index));
    };
    keep(shape->named_faces.emplace_back(), prism.LastShape());
    keep(shape->named_faces.emplace_back(), prism.FirstShape());
    for (const auto& edge : edges) {
        auto& side = shape->named_faces.emplace_back();
        for (const auto& generated : prism.Generated(edge)) {
            if (generated.ShapeType() == TopAbs_FACE) keep(side, generated);
        }
    }
    *output = shape.release();
}

extern "C" int pamat_extrude_face(const PamatShape* body, size_t face_id, const double* direction,
                                  PamatShape** output, char* error, size_t error_size) {
    if (output) *output = nullptr;
    return checked([&] {
        if (!body || !direction || !output) throw std::runtime_error("Invalid extrusion arguments");
        const auto& faces = body->named_faces.at(face_id);
        if (faces.Extent() != 1) throw std::runtime_error("Extrusion profile must resolve to one face");
        const auto& face = TopoDS::Face(faces.FindKey(1));
        TopTools_IndexedMapOfShape boundary;
        TopExp::MapShapes(face, TopAbs_EDGE, boundary);
        std::vector<TopoDS_Edge> edges;
        for (const auto& edge : boundary) edges.push_back(TopoDS::Edge(edge));
        extrude_face(face, edges, direction, output, true);
    }, error, error_size);
}

extern "C" int pamat_extrude(const double* points, size_t count, const double* direction,
                             PamatShape** output, char* error, size_t error_size) {
    if (output) *output = nullptr;
    return checked([&] {
        if (!points || !direction || !output || count < 3) {
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
        extrude_face(face.Face(), edges, direction, output);
    }, error, error_size);
}

extern "C" int pamat_extrude_circle(const double* center, double radius, const double* normal,
                                    const double* direction, PamatShape** output, char* error, size_t error_size) {
    if (output) *output = nullptr;
    return checked([&] {
        if (!center || !normal || !direction || !output) throw std::runtime_error("Invalid circle arguments");
        const gp_Ax2 axes(gp_Pnt(center[0], center[1], center[2]), gp_Dir(normal[0], normal[1], normal[2]));
        BRepBuilderAPI_MakeEdge edge(gp_Circ(axes, radius));
        BRepBuilderAPI_MakeWire wire(edge.Edge());
        BRepBuilderAPI_MakeFace face(wire.Wire(), true);
        if (!face.IsDone()) throw std::runtime_error("Could not construct the circular profile");
        extrude_face(face.Face(), {edge.Edge()}, direction, output);
    }, error, error_size);
}

static gp_Dir outward_normal(const TopoDS_Face& face, const gp_Pln& plane) {
    gp_Dir normal = plane.Axis().Direction();
    if (face.Orientation() == TopAbs_REVERSED) normal.Reverse();
    return normal;
}

extern "C" size_t pamat_face_count(const PamatShape* shape, size_t face_id) {
    return face_id < shape->named_faces.size() ? shape->named_faces[face_id].Extent() : 0;
}

extern "C" size_t pamat_face_slots(const PamatShape* shape) {
    return shape->named_faces.size();
}

extern "C" int pamat_face_ids(PamatShape* shape, size_t first, size_t count,
                              void (*sink)(void*, size_t), void* context,
                              char* error, size_t error_size) {
    return checked([&] {
        TopTools_IndexedMapOfShape faces;
        const size_t unassigned = shape->named_faces.size();
        // SIZE_MAX requests the whole body. Otherwise collect the current descendants
        // of the requested slots, including split faces and excluding deleted ones.
        if (count == std::numeric_limits<size_t>::max()) {
            TopExp::MapShapes(shape->value, TopAbs_FACE, faces);
        } else {
            if (first > unassigned || count > unassigned - first)
                throw std::runtime_error("Invalid face slot range");
            for (size_t i = first; i < first + count; ++i) {
                for (const auto& face : shape->named_faces[i]) faces.Add(face);
            }
        }
        std::vector<size_t> ids(faces.Extent() + 1, unassigned);
        for (size_t id = 0; id < unassigned; ++id) {
            const auto& descendants = shape->named_faces[id];
            if (descendants.Extent() == 1) {
                const int index = faces.FindIndex(descendants.FindKey(1));
                if (index && ids[index] == unassigned) ids[index] = id;
            }
        }
        for (int index = 1; index <= faces.Extent(); ++index) {
            if (ids[index] == unassigned) {
                ids[index] = shape->named_faces.size();
                shape->named_faces.emplace_back().Add(faces.FindKey(index));
            }
            sink(context, ids[index]);
        }
    }, error, error_size);
}

extern "C" int pamat_face_by_normal(PamatShape* shape, const double* direction, size_t* count,
                                    size_t* face_id, char* error, size_t error_size) {
    return checked([&] {
        const gp_Dir wanted(direction[0], direction[1], direction[2]);
        *count = 0;
        TopoDS_Face match;
        TopTools_IndexedMapOfShape faces;
        TopExp::MapShapes(shape->value, TopAbs_FACE, faces);
        for (int i = 1; i <= faces.Extent(); ++i) {
            const auto& face = TopoDS::Face(faces.FindKey(i));
            BRepAdaptor_Surface surface(face);
            if (surface.GetType() == GeomAbs_Plane &&
                outward_normal(face, surface.Plane()).IsEqual(wanted, Precision::Angular())) {
                ++*count;
                match = face;
            }
        }
        if (*count != 1) return;
        for (size_t i = 0; i < shape->named_faces.size(); ++i) {
            const auto& descendants = shape->named_faces[i];
            if (descendants.Extent() == 1 && descendants.Contains(match)) {
                *face_id = i;
                return;
            }
        }
        *face_id = shape->named_faces.size();
        shape->named_faces.emplace_back().Add(match);
    }, error, error_size);
}

extern "C" int pamat_face_frame(const PamatShape* shape, size_t face_id, double* frame, char* error, size_t error_size) {
    return checked([&] {
        const auto& descendants = shape->named_faces.at(face_id);
        if (descendants.Extent() != 1) throw std::runtime_error("Sketch support must resolve to one face");
        const auto& face = TopoDS::Face(descendants.FindKey(1));
        BRepAdaptor_Surface surface(face);
        if (surface.GetType() != GeomAbs_Plane) throw std::runtime_error("Sketch support is not planar");
        const gp_Pln plane = surface.Plane();
        const gp_Vec n(outward_normal(face, plane));
        // Project the body origin and X axis onto the face. Use Y on a face normal to X.
        const gp_Vec origin = n * gp_Vec(gp_Pnt(0, 0, 0), plane.Location()).Dot(n);
        const gp_Vec axis = std::abs(n.X()) < 1.0 - 1e-12 ? gp_Vec(1, 0, 0) : gp_Vec(0, 1, 0);
        const gp_Vec u = (axis - n * axis.Dot(n)).Normalized();
        const gp_Vec vectors[] = {origin, u, n.Crossed(u), n};
        for (size_t i = 0; i < 4; ++i) {
            frame[3 * i] = vectors[i].X();
            frame[3 * i + 1] = vectors[i].Y();
            frame[3 * i + 2] = vectors[i].Z();
        }
    }, error, error_size);
}

extern "C" int pamat_volume(const PamatShape* shape, double* output, char* error, size_t error_size) {
    return checked([&] {
        if (!shape || !output) throw std::runtime_error("Invalid shape handle");
        *output = volume(shape->value);
    }, error, error_size);
}

extern "C" void pamat_shape_free(PamatShape* shape) {
    delete shape;
}


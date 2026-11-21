#include "bridge_internal.hxx"
#include <BRepAdaptor_Surface.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <gp_Pln.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
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

static gp_Dir outward_normal(const TopoDS_Face& face, const gp_Pln& plane) {
    gp_Dir normal = plane.Axis().Direction();
    if (face.Orientation() == TopAbs_REVERSED) normal.Reverse();
    return normal;
}

extern "C" int pamat_face_properties(const PamatShape* body, size_t face_id, double* properties,
                                      int* surface_type, char* error, size_t error_size) {
    return checked([&] {
        const auto& face = TopoDS::Face(body->named_faces.at(face_id).FindKey(1));
        GProp_GProps props;
        BRepGProp::SurfaceProperties(face, props);
        properties[0] = props.Mass();
        const gp_Pnt center = props.CentreOfMass();
        for (int i = 1; i <= 3; ++i) properties[i] = center.Coord(i);
        switch (BRepAdaptor_Surface(face).GetType()) {
            case GeomAbs_Plane: *surface_type = 1; break;
            case GeomAbs_Cylinder: *surface_type = 2; break;
            case GeomAbs_Cone: *surface_type = 3; break;
            default: *surface_type = 0;
        }
    }, error, error_size);
}

extern "C" size_t pamat_face_count(const PamatShape* shape, size_t face_id) {
    return face_id < shape->named_faces.size() ? shape->named_faces[face_id].Extent() : 0;
}

extern "C" size_t pamat_face_slots(const PamatShape* shape) {
    return shape->named_faces.size();
}

// Assign selectable descendants before publishing the shape, so rendering or picking cannot
// change the slot layout inherited by the next modeling command.
void PamatShape::index_faces() {
    TopExp::MapShapes(value, TopAbs_FACE, faces);
    const size_t unassigned = named_faces.size();
    selectable_slots.assign(faces.Extent() + 1, unassigned);
    for (size_t id = 0; id < unassigned; ++id) {
        const auto& descendants = named_faces[id];
        if (descendants.Extent() == 1 && !historical_slots.count(id)) {
            const int index = faces.FindIndex(descendants.FindKey(1));
            if (index && selectable_slots[index] == unassigned) selectable_slots[index] = id;
        }
    }
    for (int index = 1; index <= faces.Extent(); ++index) {
        if (selectable_slots[index] == unassigned) {
            selectable_slots[index] = named_faces.size();
            named_faces.emplace_back().Add(faces.FindKey(index));
        }
    }
}

extern "C" int pamat_face_ids(const PamatShape* shape, size_t first, size_t count,
                              void (*sink)(void*, size_t), void* context,
                              char* error, size_t error_size) {
    return checked([&] {
        if (count == std::numeric_limits<size_t>::max()) {
            for (int i = 1; i <= shape->faces.Extent(); ++i) sink(context, shape->selectable_slots[i]);
            return;
        }
        const size_t size = shape->named_faces.size();
        if (first > size || count > size - first) throw std::runtime_error("Invalid face slot range");
        TopTools_IndexedMapOfShape descendants;
        for (size_t i = first; i < first + count; ++i) {
            for (const auto& face : shape->named_faces[i]) descendants.Add(face);
        }
        for (const auto& face : descendants) sink(context, shape->selectable_slots.at(shape->faces.FindIndex(face)));
    }, error, error_size);
}

extern "C" int pamat_face_by_normal(const PamatShape* shape, const double* direction, size_t* count,
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
        *face_id = shape->selectable_slots.at(shape->faces.FindIndex(match));
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


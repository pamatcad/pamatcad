#include "bridge.h"
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Cut.hxx>
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

struct PamatShape {
    TopoDS_Shape value;
    TopTools_IndexedMapOfShape end_caps;
};

template <typename Operation>
static int checked(Operation operation, char* error, size_t error_size) noexcept {
    try {
        operation();
        return 0;
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        std::snprintf(error, error_size, "%s", message ? message : "OCCT failure");
    } catch (const std::exception& failure) {
        std::snprintf(error, error_size, "%s", failure.what());
    } catch (...) {
        std::snprintf(error, error_size, "Unknown OCCT failure");
    }
    return 1;
}

static double volume(const TopoDS_Shape& shape) {
    GProp_GProps properties;
    BRepGProp::VolumeProperties(shape, properties, true, false, false);
    const double value = properties.Mass();
    if (!std::isfinite(value) || value <= 0) {
        throw std::runtime_error("Solid has no positive finite volume");
    }
    return value;
}

static double validated_volume(const TopoDS_Shape& solid) {
    if (solid.IsNull() || solid.ShapeType() != TopAbs_SOLID ||
        !BRepCheck_Analyzer(solid, true).IsValid()) {
        throw std::runtime_error("Operation did not produce a valid solid");
    }
    return volume(solid);
}

static void extrude_face(const TopoDS_Face& face, const double* direction, PamatShape** output) {
    BRepPrimAPI_MakePrism prism(face, gp_Vec(direction[0], direction[1], direction[2]));
    if (!prism.IsDone()) throw std::runtime_error("Could not extrude the profile");
    auto shape = std::make_unique<PamatShape>();
    shape->value = prism.Shape();
    validated_volume(shape->value);
    // Use the face's outward orientation in the finished solid.
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(shape->value, TopAbs_FACE, faces);
    const int index = faces.FindIndex(prism.LastShape());
    if (!index) throw std::runtime_error("Prism end face is missing from its solid");
    shape->end_caps.Add(faces.FindKey(index));
    *output = shape.release();
}

extern "C" int pamat_extrude(const double* points, size_t count, const double* direction,
                             PamatShape** output, char* error, size_t error_size) {
    if (output) *output = nullptr;
    return checked([&] {
        if (!points || !direction || !output || count < 3) {
            throw std::runtime_error("Invalid extrusion arguments");
        }
        BRepBuilderAPI_MakePolygon polygon;
        for (size_t i = 0; i < count; ++i) {
            polygon.Add(gp_Pnt(points[3 * i], points[3 * i + 1], points[3 * i + 2]));
        }
        polygon.Close();
        if (!polygon.IsDone()) throw std::runtime_error("Could not construct the profile wire");
        BRepBuilderAPI_MakeFace face(polygon.Wire(), true);
        if (!face.IsDone()) throw std::runtime_error("Could not construct the profile face");
        extrude_face(face.Face(), direction, output);
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
        extrude_face(face.Face(), direction, output);
    }, error, error_size);
}

extern "C" size_t pamat_end_cap_count(const PamatShape* shape) {
    return shape->end_caps.Extent();
}

extern "C" int pamat_end_cap_frame(const PamatShape* shape, double* frame, char* error, size_t error_size) {
    return checked([&] {
        const TopoDS_Face& face = TopoDS::Face(shape->end_caps.FindKey(1));
        BRepAdaptor_Surface surface(face);
        if (surface.GetType() != GeomAbs_Plane) throw std::runtime_error("Sketch support is not planar");
        const gp_Pln plane = surface.Plane();
        gp_Vec n(plane.Axis().Direction());
        if (face.Orientation() == TopAbs_REVERSED) n.Reverse();
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

extern "C" int pamat_cut(const PamatShape* body, const PamatShape* tool, PamatShape** output,
                         char* error, size_t error_size) {
    if (output) *output = nullptr;
    return checked([&] {
        if (!body || !tool || !output) throw std::runtime_error("Invalid cut arguments");
        BRepAlgoAPI_Cut cut;
        NCollection_List<TopoDS_Shape> arguments, tools;
        arguments.Append(body->value);
        tools.Append(tool->value);
        cut.SetArguments(arguments);
        cut.SetTools(tools);
        cut.SetNonDestructive(true);
        cut.Build();
        if (!cut.IsDone() || cut.HasErrors()) throw std::runtime_error("Boolean cut failed");
        TopExp_Explorer solids(cut.Shape(), TopAbs_SOLID);
        if (!solids.More()) throw std::runtime_error("Cut would remove the entire body");
        auto result = std::make_unique<PamatShape>();
        result->value = solids.Current();
        solids.Next();
        if (solids.More()) throw std::runtime_error("Cuts that split the target are not supported");
        const double before = volume(body->value);
        const double after = validated_volume(result->value);
        if (before - after <= 8 * std::numeric_limits<double>::epsilon() * before) return;
        TopTools_IndexedMapOfShape faces;
        TopExp::MapShapes(result->value, TopAbs_FACE, faces);
        const auto keep_face = [&](const TopoDS_Shape& candidate) {
            const int index = faces.FindIndex(candidate);
            if (index) result->end_caps.Add(faces.FindKey(index));
        };
        for (int i = 1; i <= body->end_caps.Extent(); ++i) {
            const auto& cap = body->end_caps.FindKey(i);
            const auto& descendants = cut.Modified(cap);
            if (descendants.IsEmpty() && !cut.IsDeleted(cap)) keep_face(cap);
            for (const auto& face : descendants) keep_face(face);
        }
        *output = result.release();
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


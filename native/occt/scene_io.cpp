#include "bridge_internal.hxx"
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <STEPControl_Writer.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <algorithm>
#include <sstream>
#include <stdexcept>

extern "C" int pamat_write_step(const PamatShape* const* shapes, size_t count, PamatBytes sink,
                                void* context, char* error, size_t error_size) {
    return checked([&] {
        STEPControl_Writer writer;
        for (size_t i = 0; i < count; ++i) {
            if (writer.Transfer(shapes[i]->value, STEPControl_AsIs) != IFSelect_RetDone)
                throw std::runtime_error("Could not transfer body to STEP");
        }
        std::ostringstream output;
        if (writer.WriteStream(output) != IFSelect_RetDone || !output.good())
            throw std::runtime_error("Could not write STEP file");
        const auto bytes = output.str();
        sink(context, reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size());
    }, error, error_size);
}

double mesh_for_display(const TopoDS_Shape& copy) {
    Bnd_Box bounds;
    BRepBndLib::Add(copy, bounds, false);
    const double deflection = std::max(1e-7, bounds.CornerMin().Distance(bounds.CornerMax()) * 0.0005);
    BRepMesh_IncrementalMesh mesher(copy, deflection, false, 0.12);
    if (!mesher.IsDone()) throw std::runtime_error("Could not tessellate body");
    return deflection;
}

extern "C" int pamat_mesh(const PamatShape* shape, PamatTriangle sink, void* context,
                          char* error, size_t error_size) {
    return checked([&] {
        // Tessellation attaches data to faces. Mesh a topology copy to keep the scene read-only.
        const TopoDS_Shape copy = BRepBuilderAPI_Copy(shape->value, false, false).Shape();
        mesh_for_display(copy);
        for (TopExp_Explorer faces(copy, TopAbs_FACE); faces.More(); faces.Next()) {
            const auto& face = TopoDS::Face(faces.Current());
            TopLoc_Location location;
            const auto mesh = BRep_Tool::Triangulation(face, location);
            if (mesh.IsNull()) throw std::runtime_error("Face has no triangulation");
            for (int i = 1; i <= mesh->NbTriangles(); ++i) {
                int nodes[3];
                mesh->Triangle(i).Get(nodes[0], nodes[1], nodes[2]);
                if (face.Orientation() == TopAbs_REVERSED) std::swap(nodes[1], nodes[2]);
                double xyz[9];
                for (int j = 0; j < 3; ++j) {
                    const gp_Pnt p = mesh->Node(nodes[j]).Transformed(location.Transformation());
                    xyz[j * 3] = p.X();
                    xyz[j * 3 + 1] = p.Y();
                    xyz[j * 3 + 2] = p.Z();
                }
                sink(context, xyz);
            }
        }
    }, error, error_size);
}

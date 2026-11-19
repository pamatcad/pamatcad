#include "bridge_internal.hxx"
#include <BRepAdaptor_Curve.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepLib_ToolTriangulatedShape.hxx>
#include <BRep_Tool.hxx>
#include <GCPnts_QuasiUniformDeflection.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>

template<typename Point>
static void append_xyz(std::vector<float>& target, const Point& point) {
    for (int axis = 1; axis <= 3; ++axis)
        target.push_back(static_cast<float>(point.Coord(axis)));
}

extern "C" int pamat_proxy(const PamatShape* shape, PamatProxyFace face_sink, PamatProxyEdge edge_sink,
                           void* context, char* error, size_t error_size) {
    return checked([&] {
        BRepBuilderAPI_Copy copy(shape->value, false, false);
        const double deflection = mesh_for_display(copy.Shape());

        for (int f = 1; f <= shape->faces.Extent(); ++f) {
            const auto& original = shape->faces.FindKey(f);
            const auto face = TopoDS::Face(copy.ModifiedShape(original));
            TopLoc_Location location;
            const auto mesh = BRep_Tool::Triangulation(face, location);
            if (mesh.IsNull()) throw std::runtime_error("Proxy face has no triangulation");
            BRepLib_ToolTriangulatedShape::ComputeNormals(face, mesh);
            const bool reversed = original.Orientation() == TopAbs_REVERSED;
            std::vector<float> xyz, normals;
            std::vector<uint32_t> indices;
            for (int i = 1; i <= mesh->NbNodes(); ++i) {
                append_xyz(xyz, mesh->Node(i).Transformed(location.Transformation()));
                auto normal = mesh->Normal(i).Transformed(location.Transformation());
                if (reversed) normal.Reverse();
                append_xyz(normals, normal);
            }
            for (int i = 1; i <= mesh->NbTriangles(); ++i) {
                int a, b, c;
                mesh->Triangle(i).Get(a, b, c);
                if (reversed) std::swap(b, c);
                for (int n : {a, b, c}) indices.push_back(static_cast<uint32_t>(n - 1));
            }
            face_sink(context, shape->selectable_slots[f], mesh->NbNodes(), xyz.data(), normals.data(),
                      mesh->NbTriangles(), indices.data());
        }

        TopTools_IndexedMapOfShape edges;
        TopExp::MapShapes(shape->value, TopAbs_EDGE, edges);
        for (int i = 1; i <= edges.Extent(); ++i) {
            const auto& edge = TopoDS::Edge(edges.FindKey(i));
            if (BRep_Tool::Degenerated(edge)) continue;
            BRepAdaptor_Curve curve(edge);
            GCPnts_QuasiUniformDeflection line(curve, deflection);
            if (!line.IsDone() || line.NbPoints() < 2) throw std::runtime_error("Could not sample proxy edge");
            const bool closed = BRep_Tool::IsClosed(edge);
            const int count = line.NbPoints() - (closed ? 1 : 0);
            std::vector<float> xyz;
            for (int j = 1; j <= count; ++j) append_xyz(xyz, line.Value(j));
            edge_sink(context, i - 1, count, xyz.data(), closed);
        }
    }, error, error_size);
}

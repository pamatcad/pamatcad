#include "bridge_internal.hxx"
#include <BOPAlgo_Builder.hxx>
#include <BOPAlgo_BuilderFace.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepTools.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <GCPnts_QuasiUniformDeflection.hxx>
#include <Geom_BSplineCurve.hxx>
#include <GeomAPI_Interpolate.hxx>
#include <GProp_GProps.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Wire.hxx>
#include <TColgp_HArray1OfPnt.hxx>
#include <gp_Circ.hxx>
#include <gp_Elips.hxx>
#include <gp_Pln.hxx>
#include <map>
#include <memory>
#include <cmath>

struct PamatSketchCurve { int32_t kind; size_t start, count; };
using RegionSink = void (*)(void*, PamatShape*, const size_t*, const int32_t*, size_t);
namespace {
std::vector<double> sample_wire(const TopoDS_Wire& wire,const TopoDS_Face& face) {
    std::vector<double> points;
    for (BRepTools_WireExplorer it(wire,face);it.More();it.Next()) {
        BRepAdaptor_Curve curve(it.Current());
        GCPnts_QuasiUniformDeflection sample(curve,0.02);
        const bool reversed=it.Current().Orientation()==TopAbs_REVERSED;
        const int count=sample.IsDone()?sample.NbPoints():2;
        for(int i=0;i<count-1;++i){
            const int index=reversed?count-i:i+1;
            const auto p=sample.IsDone()?sample.Value(index):curve.Value(reversed?curve.LastParameter():curve.FirstParameter());
            points.insert(points.end(),{p.X(),p.Y(),p.Z()});
        }
    }
    return points;
}
}
static std::vector<TopoDS_Edge> make_sketch_edges(const double* frame,const PamatSketchCurve* curves,size_t count,const double* data){
        const gp_Pnt origin(frame[0],frame[1],frame[2]);
        const gp_Vec u(frame[3],frame[4],frame[5]),v(frame[6],frame[7],frame[8]);
        const gp_Dir normal(frame[9],frame[10],frame[11]);
        const auto point=[&](double x,double y){return origin.Translated(u*x+v*y);};
        const auto axes=[&](double x,double y,double angle=0.){return gp_Ax2(point(x,y),normal,gp_Dir(u*std::cos(angle)+v*std::sin(angle)));};
        auto plane=BRepBuilderAPI_MakeFace(gp_Pln(gp_Ax3(origin,normal,gp_Dir(u)))).Face();
        std::vector<TopoDS_Edge> original;
        for(size_t i=0;i<count;++i){
            const auto& descriptor=curves[i];const double* p=data+descriptor.start;TopoDS_Edge edge;
            switch(descriptor.kind){
            case 0:edge=BRepBuilderAPI_MakeEdge(point(p[0],p[1]),point(p[2],p[3])).Edge();break;
            case 1:edge=BRepBuilderAPI_MakeEdge(gp_Circ(axes(p[0],p[1]),p[2])).Edge();break;
            case 2:{auto circle=gp_Circ(axes(p[0],p[1]),p[2]);edge=BRepBuilderAPI_MakeEdge(circle,std::min(p[3],p[4]),std::max(p[3],p[4])).Edge();if(p[4]<p[3])edge.Reverse();break;}
            case 3:{double major=p[2],minor=p[3],angle=p[4];if(minor>major){std::swap(major,minor);angle+=std::acos(-1.)/2.;}edge=BRepBuilderAPI_MakeEdge(gp_Elips(axes(p[0],p[1],angle),major,minor)).Edge();break;}
            case 4:{
                const int degree=static_cast<int>(p[0]),n=static_cast<int>(p[1]);const bool closed=p[2]!=0.,fit=p[3]!=0.;
                TColgp_Array1OfPnt poles(1,n);for(int j=0;j<n;++j)poles(j+1)=point(p[4+2*j],p[5+2*j]);
                Handle(Geom_BSplineCurve) spline;
                if(fit){const int fit_count=closed&&poles(1).Distance(poles(n))<1e-7?n-1:n;Handle(TColgp_HArray1OfPnt) positions=new TColgp_HArray1OfPnt(1,fit_count);for(int k=1;k<=fit_count;++k)positions->SetValue(k,poles(k));GeomAPI_Interpolate interpolation(positions,closed,1e-7);interpolation.Perform();if(!interpolation.IsDone())throw std::runtime_error("Could not interpolate sketch spline");spline=interpolation.Curve();}
                else{
                    std::map<double,int> distinct;const double* knots=p+4+2*n;for(int j=0;j<n+degree+1;++j)distinct[knots[j]]++;
                    NCollection_Array1<double> knot_values(1,distinct.size());NCollection_Array1<int> multiplicities(1,distinct.size());int j=1;
                    for(const auto& [value,multiplicity]:distinct){knot_values(j)=value;multiplicities(j++)=multiplicity;}
                    NCollection_Array1<double> weights(1,n);const double* weight_values=knots+n+degree+1;for(int i=0;i<n;++i)weights(i+1)=weight_values[i];
                    spline=new Geom_BSplineCurve(poles,weights,knot_values,multiplicities,degree,false);
                    if(closed&&!spline->IsClosed())throw std::runtime_error("Closed control spline endpoints must coincide");
                }
                edge=BRepBuilderAPI_MakeEdge(spline).Edge();break;
            }
            default:throw std::runtime_error("Unsupported sketch curve");
            }
            BRepLib::BuildPCurveForEdgeOnPlane(edge,plane);
            original.push_back(edge);
        }
        return original;
}
extern "C" int pamat_sketch_regions(const double* frame,const PamatSketchCurve* curves,size_t count,
                                     const double* data,RegionSink sink,void* context,char* error,size_t error_size) {
    return checked([&]{
        if(!count)return;
        auto original=make_sketch_edges(frame,curves,count,data);
        NCollection_List<TopoDS_Shape> arguments;for(const auto& edge:original)arguments.Append(edge);
        auto plane=BRepBuilderAPI_MakeFace(gp_Pln(gp_Ax3(gp_Pnt(frame[0],frame[1],frame[2]),gp_Dir(frame[9],frame[10],frame[11]),gp_Dir(frame[3],frame[4],frame[5])))).Face();
        BOPAlgo_Builder split;
        split.SetArguments(arguments);split.SetFuzzyValue(1e-7);split.SetNonDestructive(true);
        TopTools_IndexedMapOfShape edges;
        if(count>1){split.Perform();if(split.HasErrors())throw std::runtime_error("Could not intersect sketch curves");TopExp::MapShapes(split.Shape(),TopAbs_EDGE,edges);}
        else edges.Add(original[0]);
        std::vector<size_t> sources(edges.Extent(),static_cast<size_t>(-1));
        for(size_t i=0;i<count;++i){
            const auto mark=[&](const TopoDS_Shape& e){int index=edges.FindIndex(e);if(index&&sources[index-1]==static_cast<size_t>(-1))sources[index-1]=i;};
            mark(original[i]);if(count>1)for(const auto& e:split.Modified(original[i]))mark(e);
        }
        NCollection_List<TopoDS_Shape> oriented;
        for(const auto& item:edges){auto edge=TopoDS::Edge(item);BRepLib::BuildPCurveForEdgeOnPlane(edge,plane);oriented.Append(edge.Oriented(TopAbs_FORWARD));oriented.Append(edge.Oriented(TopAbs_REVERSED));}
        BOPAlgo_BuilderFace builder;builder.SetFace(plane);builder.SetShapes(oriented);builder.SetAvoidInternalShapes(true);builder.Perform();
        if(builder.HasErrors())throw std::runtime_error("Could not build sketch regions");
        for(const auto& item:builder.Areas()){
            auto face=TopoDS::Face(item);auto outer=BRepTools::OuterWire(face);if(outer.IsNull())continue;
            GProp_GProps properties;BRepGProp::SurfaceProperties(face,properties);
            if(!std::isfinite(properties.Mass())||properties.Mass()<1e-12||properties.Mass()>1e90)continue;
            TopTools_IndexedMapOfShape boundary;TopExp::MapShapes(face,TopAbs_EDGE,boundary);
            std::vector<size_t> source;std::vector<int32_t> orientation;
            for(const auto& edge:boundary){const auto index=edges.FindIndex(edge);if(!index||sources[index-1]==static_cast<size_t>(-1))throw std::runtime_error("Lost sketch boundary source");source.push_back(sources[index-1]);orientation.push_back(edge.Orientation()==TopAbs_REVERSED?-1:1);}
            auto shape=std::make_unique<PamatShape>();shape->value=face;shape->named_faces.resize(1);shape->named_faces[0].Add(face);shape->index_faces();
            sink(context,shape.release(),source.data(),orientation.data(),source.size());
        }
    },error,error_size);
}

extern "C" int pamat_sketch_profile_proxy(const PamatShape* shape,void(*sink)(void*,const double*,size_t),void* context,char* error,size_t error_size){
    return checked([&]{
        const auto face=TopoDS::Face(shape->value);const auto outer=BRepTools::OuterWire(face);
        auto points=sample_wire(outer,face);sink(context,points.data(),points.size()/3);
        for(TopExp_Explorer it(face,TopAbs_WIRE);it.More();it.Next())if(!it.Current().IsSame(outer)){
            points=sample_wire(TopoDS::Wire(it.Current()),face);sink(context,points.data(),points.size()/3);
        }
    },error,error_size);
}

#include <BRep_Tool.hxx>
#include <GeomProjLib.hxx>
#include <Geom_Plane.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <GeomConvert.hxx>
#include <Geom_Line.hxx>
#include <Geom_Circle.hxx>
#include <Geom_Ellipse.hxx>
#include <GeomAdaptor_Curve.hxx>
#include <gp_Trsf.hxx>

extern "C" int pamat_sketch_project(const PamatShape* body,int kind,size_t index,const double* frame,
    void(*sink)(void*,int,const double*,size_t),void* context,char* error,size_t error_size){
    return checked([&]{
        const gp_Ax3 axes(gp_Pnt(frame[0],frame[1],frame[2]),gp_Dir(frame[9],frame[10],frame[11]),gp_Dir(frame[3],frame[4],frame[5]));
        Handle(Geom_Plane) plane=new Geom_Plane(axes);gp_Trsf local;local.SetTransformation(axes);
        if(kind==2){TopTools_IndexedMapOfShape vertices;TopExp::MapShapes(body->value,TopAbs_VERTEX,vertices);if(index>=static_cast<size_t>(vertices.Extent()))throw std::invalid_argument("Vertex does not exist");
            const auto p=BRep_Tool::Pnt(TopoDS::Vertex(vertices(index+1))).Transformed(local);const double data[]={p.X(),p.Y()};sink(context,0,data,2);return;}
        TopTools_IndexedMapOfShape edges;
        if(kind==0){const auto& faces=body->named_faces.at(index);if(faces.Extent()!=1)throw std::invalid_argument("Projection face is ambiguous");TopExp::MapShapes(faces(1),TopAbs_EDGE,edges);}
        else{TopTools_IndexedMapOfShape all;TopExp::MapShapes(body->value,TopAbs_EDGE,all);if(index>=static_cast<size_t>(all.Extent()))throw std::invalid_argument("Edge does not exist");edges.Add(all(index+1));}
        for(const auto& shape:edges){
            double first,last;Handle(Geom_Curve) source=BRep_Tool::Curve(TopoDS::Edge(shape),first,last);
            if(source.IsNull())continue;
            Handle(Geom_Curve) projected=GeomProjLib::ProjectOnPlane(source,plane,axes.Direction(),true);
            if(projected.IsNull()){
                const auto a=source->Value(first).Transformed(local),b=source->Value(last).Transformed(local);
                if(std::hypot(a.X()-b.X(),a.Y()-b.Y())>1e-7)throw std::runtime_error("Could not project edge");
                const double data[]={a.X(),a.Y()};sink(context,0,data,2);continue;
            }
            projected=Handle(Geom_Curve)::DownCast(projected->Transformed(local));
            GeomAdaptor_Curve curve(projected,first,last);
            if(curve.GetType()==GeomAbs_Line){const auto a=curve.Value(first),b=curve.Value(last);const double data[]={a.X(),a.Y(),b.X(),b.Y()};if(std::hypot(a.X()-b.X(),a.Y()-b.Y())<1e-7)sink(context,0,data,2);else sink(context,1,data,4);continue;}
            Handle(Geom_TrimmedCurve) trimmed=new Geom_TrimmedCurve(projected,first,last);
            auto spline=GeomConvert::CurveToBSplineCurve(trimmed);
            if(spline->IsPeriodic())spline->SetNotPeriodic();
            const auto n=spline->NbPoles();std::vector<double> data{static_cast<double>(spline->Degree()),static_cast<double>(n),spline->IsClosed()?1.:0.,0.};
            for(int i=1;i<=n;++i){auto p=spline->Pole(i);data.insert(data.end(),{p.X(),p.Y()});}
            for(int i=1;i<=spline->NbKnots();++i)for(int j=0;j<spline->Multiplicity(i);++j)data.push_back(spline->Knot(i));
            for(int i=1;i<=n;++i)data.push_back(spline->Weight(i));
            sink(context,4,data.data(),data.size());
        }
    },error,error_size);
}

extern "C" int pamat_sketch_curve_proxy(const double* frame,const PamatSketchCurve* curve,const double* data,
    void(*sink)(void*,const double*,size_t),void* context,char* error,size_t error_size){
    return checked([&]{auto edges=make_sketch_edges(frame,curve,1,data);BRepAdaptor_Curve adaptor(edges[0]);
        GCPnts_QuasiUniformDeflection sampling(adaptor,0.01);if(!sampling.IsDone())throw std::runtime_error("Could not sample sketch curve");
        std::vector<double> points;for(int i=1;i<=sampling.NbPoints();++i){auto p=sampling.Value(i);points.insert(points.end(),{p.X(),p.Y(),p.Z()});}sink(context,points.data(),points.size()/3);
    },error,error_size);
}

#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepOffsetAPI_MakeOffset.hxx>
#include <ChFi2d_FilletAPI.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
using CurveSink=void(*)(void*,size_t,int,const double*,size_t);
static void emit_sketch_edge(const TopoDS_Edge& edge,const gp_Trsf& local,size_t source,CurveSink sink,void* context){
    double first,last;auto geometry=BRep_Tool::Curve(edge,first,last);if(geometry.IsNull())return;
    geometry=Handle(Geom_Curve)::DownCast(geometry->Transformed(local));GeomAdaptor_Curve curve(geometry,first,last);
    auto a=curve.Value(first),b=curve.Value(last);if(edge.Orientation()==TopAbs_REVERSED)std::swap(a,b);
    if(curve.GetType()==GeomAbs_Line){const double data[]={a.X(),a.Y(),b.X(),b.Y()};sink(context,source,1,data,4);return;}
    if(curve.GetType()==GeomAbs_Circle){auto circle=curve.Circle();auto center=circle.Location();double start=std::atan2(a.Y()-center.Y(),a.X()-center.X());double sweep=(last-first)*(circle.Axis().Direction().Z()<0.?-1.:1.)*(edge.Orientation()==TopAbs_REVERSED?-1.:1.);
        const double data[]={center.X(),center.Y(),circle.Radius(),start,start+sweep};sink(context,source,std::abs(last-first-2.*std::acos(-1.))<1e-7?2:3,data,5);return;}
    auto spline=GeomConvert::CurveToBSplineCurve(new Geom_TrimmedCurve(geometry,first,last));if(spline->IsPeriodic())spline->SetNotPeriodic();if(edge.Orientation()==TopAbs_REVERSED)spline->Reverse();
    int n=spline->NbPoles();std::vector<double> data{static_cast<double>(spline->Degree()),static_cast<double>(n),spline->IsClosed()?1.:0.,0.};
    for(int i=1;i<=n;++i){auto p=spline->Pole(i);data.insert(data.end(),{p.X(),p.Y()});}
    for(int i=1;i<=spline->NbKnots();++i)for(int j=0;j<spline->Multiplicity(i);++j)data.push_back(spline->Knot(i));
    for(int i=1;i<=n;++i)data.push_back(spline->Weight(i));sink(context,source,4,data.data(),data.size());
}
extern "C" int pamat_sketch_modify(const double* frame,const PamatSketchCurve* curves,size_t count,const double* data,int operation,double value,CurveSink sink,void* context,char* error,size_t error_size){
    return checked([&]{
        auto edges=make_sketch_edges(frame,curves,count,data);if(edges.empty())throw std::invalid_argument("Select sketch curves");
        gp_Ax3 axes(gp_Pnt(frame[0],frame[1],frame[2]),gp_Dir(frame[9],frame[10],frame[11]),gp_Dir(frame[3],frame[4],frame[5]));gp_Trsf local;local.SetTransformation(axes);
        const auto emit=[&](const TopoDS_Shape& shape,size_t source){TopTools_IndexedMapOfShape result;TopExp::MapShapes(shape,TopAbs_EDGE,result);for(const auto& e:result)emit_sketch_edge(TopoDS::Edge(e),local,source,sink,context);};
        if(operation==0){
            BOPAlgo_Builder split;NCollection_List<TopoDS_Shape> arguments;for(const auto&e:edges)arguments.Append(e);split.SetArguments(arguments);split.SetNonDestructive(true);split.SetFuzzyValue(1e-7);split.Perform();if(split.HasErrors())throw std::runtime_error("Could not split sketch curves");
            for(size_t i=0;i<count;++i){const auto& parts=split.Modified(edges[i]);if(parts.Size()>1)for(const auto& e:parts)emit(e,i);}
        }else if(operation==1){
            BRepBuilderAPI_MakeWire wire;NCollection_List<TopoDS_Shape> list;for(const auto&e:edges)list.Append(e);wire.Add(list);if(!wire.IsDone())throw std::invalid_argument("Offset requires connected curves");
            BRepOffsetAPI_MakeOffset offset(wire.Wire(),GeomAbs_Arc,false);offset.Perform(value);if(!offset.IsDone())throw std::runtime_error("Could not offset sketch curves");emit(offset.Shape(),count);
        }else if(operation==2){
            std::vector<TopoDS_Edge> fillets;bool changed=false;
            for(size_t i=0;i<count;++i)for(size_t j=i+1;j<count;++j){
                BRepAdaptor_Curve a(edges[i]),b(edges[j]);gp_Pnt corner;bool found=false;
                for(auto x:{a.FirstParameter(),a.LastParameter()})for(auto y:{b.FirstParameter(),b.LastParameter()})if(a.Value(x).Distance(b.Value(y))<1e-7){corner=a.Value(x);found=true;}
                if(!found)continue;
                ChFi2d_FilletAPI fillet(edges[i],edges[j],gp_Pln(axes));if(!fillet.Perform(value))throw std::runtime_error("Could not round a selected corner at this radius");
                auto arc=fillet.Result(corner,edges[i],edges[j]);if(arc.IsNull())throw std::runtime_error("No rounding solution at selected corner");fillets.push_back(arc);changed=true;
            }
            if(!changed)throw std::invalid_argument("Rounding requires curves sharing a corner");
            for(size_t i=0;i<count;++i)emit(edges[i],i);for(const auto& e:fillets)emit(e,count);
        }else if(operation==3){
            struct Cells{std::vector<std::unique_ptr<PamatShape>> faces;};Cells cells;
            const auto receive=[](void* c,PamatShape* face,const size_t*,const int32_t*,size_t){static_cast<Cells*>(c)->faces.emplace_back(face);};
            char detail[1024];if(pamat_sketch_regions(frame,curves,count,data,receive,&cells,detail,sizeof(detail)))throw std::runtime_error(detail);
            std::vector<std::pair<gp_Pnt,gp_Pnt>> segments;
            for(const auto& e:edges){BRepAdaptor_Curve c(e);GCPnts_QuasiUniformDeflection sample(c,0.0001);if(!sample.IsDone())throw std::runtime_error("Could not classify text contours");for(int i=1;i<sample.NbPoints();++i)segments.emplace_back(sample.Value(i).Transformed(local),sample.Value(i+1).Transformed(local));}
            TopoDS_Shape result;
            for(const auto& cell:cells.faces){auto face=TopoDS::Face(cell->value);double u0,u1,v0,v1;BRepTools::UVBounds(face,u0,u1,v0,v1);gp_Pnt2d inside;bool found=false;
                for(int grid:{3,7,17,37}){for(int i=0;i<grid&&!found;++i)for(int j=0;j<grid&&!found;++j){gp_Pnt2d p(u0+(u1-u0)*(i+0.5)/grid,v0+(v1-v0)*(j+0.5)/grid);BRepClass_FaceClassifier test(face,p,1e-8);if(test.State()==TopAbs_IN){inside=p;found=true;}}if(found)break;}
                if(!found)continue;int winding=0;for(const auto&[a,b]:segments){double cross=(b.X()-a.X())*(inside.Y()-a.Y())-(inside.X()-a.X())*(b.Y()-a.Y());if(a.Y()<=inside.Y()&&b.Y()>inside.Y()&&cross>0.)++winding;if(a.Y()>inside.Y()&&b.Y()<=inside.Y()&&cross<0.)--winding;}
                if(!winding)continue;if(result.IsNull())result=face;else{BRepAlgoAPI_Fuse merge(result,face);if(!merge.IsDone())throw std::runtime_error("Could not combine text contours");result=merge.Shape();}
            }
            if(result.IsNull())return;ShapeUpgrade_UnifySameDomain unified(result,true,true,false);unified.Build();emit(unified.Shape(),count);
        }else throw std::invalid_argument("Unknown sketch edit");
    },error,error_size);
}

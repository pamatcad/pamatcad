import assert from "node:assert/strict";

export async function testSketchConstructors(page,sdk) {
  const results=await page.evaluate(async sdk=>{
    const {Core}=await import(sdk);
    const {editorTransport}=await import("/src/runtime/transport.ts");
    const {drawing}=await import("/src/tools/sketch-geometry.ts");
    const core=new Core(editorTransport(()=>{})),scene=await core.scene.create("Sketch constructors");
    const sketch=await scene.sketches.create(scene.construction.builtin.planes.xy);
    const fields={width:20,height:10,radius:10,angle:90,size:10,text:"B",weight:400,horizontal:"left",vertical:"baseline",closed:false};
    try {
      const base=await sketch.state();
      const make=(tool,variant,points,f=fields,selected=[],state=base)=>drawing(tool,variant,points,f,false,selected,state);
      const circle2=make("circle",1,[[0,0],[10,0]]);
      const circle3=make("circle",2,[[0,0],[10,0],[0,10]]);
      const arc3=make("arc",1,[[10,0],[0,10],[-10,0]]);
      const rectangle=make("rectangle",1,[[0,0],[10,10],[5,15]]);
      await sketch.primitives.add(rectangle.type,rectangle.parameters);
      await sketch.complete();
      const feature=await core.solid.extrude(await sketch.regions.only(),{length1:1});
      const angledArea=(await (await scene.bodies.get(feature.newSolids[0].id)).properties()).volume.value;
      const tangent=await scene.sketches.create(scene.construction.builtin.planes.xy);
      const x=await tangent.primitives.add("line",{from:[0,0],to:[20,0]});
      const y=await tangent.primitives.add("line",{from:[0,20],to:[0,0]});
      const z=await tangent.primitives.add("line",{from:[20,0],to:[0,20]});
      const state=await tangent.state();const curves=[x,y,z].map(l=>state.entities.find(e=>e.reference.id===l.curves[0].id));
      const tangent2=make("circle",3,[[4,4]],{...fields,radius:5},curves.slice(0,2),state);
      const tangent3=make("circle",4,[[5,5]],{...fields,radius:5},curves,state);
      const added=await tangent.primitives.add("circle",tangent3.parameters);
      await tangent.constraints.add("fix",{curves:[...x.curves,...y.curves,...z.curves]});
      for(const line of [x,y,z])await tangent.constraints.add("tangent",{curves:[line.curves[0],added.curves[0]]});
      return {circle2:circle2.parameters,circle3:circle3.parameters,arc3:arc3.parameters,angledArea,tangent2:tangent2.parameters,tangent3:tangent3.parameters,
        ellipseCenter:make("ellipse",0,[[5,10],[15,15]]).parameters,ellipseRectangle:make("ellipse",1,[[0,0],[20,10]]).parameters,
        slot3:make("slot",0,[[0,0],[20,0],[20,5]]).parameters,slotCenter:make("slot",1,[[10,0],[20,0]],{...fields,radius:5}).parameters,
        slotCenters:make("slot",2,[[0,0],[20,0]],{...fields,radius:5}).parameters};
    }finally{await scene.close();core.close();}
  },sdk);
  const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
  near(results.angledArea,100);
  assert.deepEqual(results.circle3.center,[5,5]);near(results.circle3.diameter,Math.sqrt(200));
  near(results.circle2.center[0],5);near(results.circle2.center[1],Math.sqrt(75));
  near(results.arc3.radius,10);near(results.arc3.end-results.arc3.start,180);
  near(results.tangent2.center[0],5);near(results.tangent2.center[1],5);
  near(results.tangent3.diameter/2,20-10*Math.sqrt(2));
  assert.deepEqual(results.ellipseCenter.center,[5,10]);assert.equal(results.ellipseCenter.major,10);assert.equal(results.ellipseCenter.minor,5);
  assert.deepEqual(results.ellipseRectangle.center,[10,5]);
  assert.deepEqual(results.slot3,results.slotCenter);assert.deepEqual(results.slot3,results.slotCenters);
  console.log("Sketch construction variants: angled rectangle, point/tangent circles, three-point arc, ellipse and slot variants passed");
}

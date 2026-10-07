/** A deterministic runtime protocol fixture. No host or project files are touched. */
export async function mockRuntime(page) {
  const writes = [];
  writes.settings = [];
  await page.routeWebSocket(/ws:\/\/127\.0\.0\.1:\d+/, socket => {
    const send = data => socket.send(JSON.stringify(data));
    const profile = { schemaVersion: 1, drive: { maxPower: 0.7 }, launcher: { hood: 55, enabled: true } };
    const files = [
      {path:'biobuzz/robot-profile.json',text:JSON.stringify(profile,null,2)},
      {path:'biobuzz/robot-profile.schema.json',text:JSON.stringify({type:'object',properties:{schemaVersion:{type:'integer'},drive:{type:'object',properties:{maxPower:{type:'number',minimum:0,maximum:1,description:'Maximum drive power. Reduce it for precise movements.'}}},launcher:{type:'object',properties:{hood:{type:'number',minimum:0,maximum:89},enabled:{type:'boolean',description:'Allow the feeder to launch balls.'}}}}})}
    ];
    let opMode='Demo: Driver control';
    socket.onMessage(raw => {
      const msg=JSON.parse(String(raw));
      if(msg.type==='settingsSave') { writes.settings.push(msg); send({type:'settingsSaved',ok:true,path:'/demo/twin-settings.json'}); send({type:'settings',exists:true,path:'/demo/twin-settings.json',text:msg.text}); }
      if(msg.type==='init') { opMode=msg.opMode; send({type:'status',status:'INIT',opMode}); }
      if(msg.type==='start') {send({type:'status',status:'RUNNING',opMode});send({type:'telemetry',lines:['Demo runtime • illustrative telemetry','Drive: ready','Camera: 2 tags visible','Flywheel: idle']});}
      if(msg.type==='stop') send({type:'status',status:'STOPPED',opMode});
      if(msg.type==='writeAsset'){writes.push(msg);const f=files.find(f=>f.path===msg.path);if(f)f.text=msg.text;send({type:'assetWritten',path:msg.path,ok:true,file:'/demo/TeamCode/src/main/assets/'+msg.path});send({type:'assets',files});}
    });
    send({type:'opmodes',opModes:[{name:opMode,flavor:'TeleOp',group:'Demo',className:'DemoDriver'},{name:'Demo: Autonomous',flavor:'Autonomous',group:'Demo',className:'DemoAuto'}]});
    send({type:'assets',files,bindings:{path:'twin-bindings.json',text:JSON.stringify({version:1,bindings:[{asset:'biobuzz/robot-profile.json',key:'launcher.hood',twin:'launcher.elevationDeg'}]})}});
    send({type:'settings',exists:false,path:'/demo/twin-settings.json'});
    send({type:'status',status:'IDLE'});
  });
  return writes;
}

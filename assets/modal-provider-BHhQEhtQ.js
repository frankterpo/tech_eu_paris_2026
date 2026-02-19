import{M as c,r,j as o}from"./helpers-a_il61DA.js";const l=`
.sb-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 9998;
}
.sb-modal-container {
  border-radius: 12px;
  position: fixed;
  inset: 0;
  margin: auto;
  width: fit-content;
  height: fit-content;
  background: white;
  z-index: 9999;
}
`;function m({children:s}){const e=c.getInstance(),{mode:a}=r.useSyncExternalStore(e.getHostContextStore("view").subscribe,e.getHostContextStore("view").getSnapshot),n=a==="modal",d=t=>{t.target===t.currentTarget&&e.closeModal()};return r.useEffect(()=>{if(!n)return;const t=i=>{i.key==="Escape"&&e.closeModal()};return document.addEventListener("keydown",t),()=>document.removeEventListener("keydown",t)},[n,e]),o.jsxs(o.Fragment,{children:[o.jsx("style",{children:l}),n&&o.jsx("div",{role:"dialog",className:"sb-modal-backdrop",onClick:d}),o.jsx("div",{className:n?"sb-modal-container":void 0,children:s})]})}export{m as ModalProvider};

/* The spare GPU is an illustration, with one ten-second CSS timeline and no animation RAF. */
(() => {
  'use strict';
  let serial = 0;
  function artwork(id = 'offpeak-spare-gpu') {
    const screw = (x,y) => `<g transform="translate(${x} ${y})"><circle r="3.6" fill="#cbccc8" stroke="#6d706b" stroke-width=".7"/><path d="M-1.6 1.6 1.6-1.6" stroke="#686b66" stroke-width=".9"/></g>`;
    const fan = (x, reverse = false) => `<g transform="translate(${x} 151)"><circle r="44" fill="#b7b9b4" stroke="#4e524c" stroke-width="1.4"/><circle r="41" fill="url(#${id}-rim)" stroke="#eaeae6" stroke-width="1"/><circle r="36" fill="#232623" stroke="#767b72" stroke-width="1"/><g class="gpu-fan${reverse?' gpu-fan-reverse':''}">${Array.from({length:9}, (_,i) => `<g transform="rotate(${i*40})"><path d="M-5-17C-18-21-20-30-10-35C-3-37 9-34 17-29C5-28 5-19 4-14Z" fill="url(#${id}-blade)" stroke="#b1b3ae1c" stroke-width=".7"/><path d="M-6-20C-14-23-15-30-9-32" fill="none" stroke="#c5c7bd" stroke-opacity=".3" stroke-width=".7"/></g>`).join('')}</g><circle r="20.6" fill="#7c8177" stroke="#c5c8bd" stroke-width=".6"/><circle r="18.5" fill="url(#${id}-screen)" stroke="#1b1e19"/><path d="M-12-10Q0-18 12-10" fill="none" stroke="#fbfcf6" stroke-opacity=".12" stroke-width="1"/></g>`;
    return `<svg class="gpu-companion-art" viewBox="0 0 288 254" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="${id}-case" x2="0" y2="1"><stop stop-color="#f8f8f2"/><stop offset=".04" stop-color="#e7e7e1"/><stop offset=".2" stop-color="#d9dad4"/><stop offset=".84" stop-color="#ced0c9"/><stop offset=".98" stop-color="#e8e9e3"/><stop offset="1" stop-color="#979b93"/></linearGradient>
        <linearGradient id="${id}-bevel" x2="0" y2="1"><stop stop-color="#949691"/><stop offset=".08" stop-color="#454743"/><stop offset=".8" stop-color="#323531"/><stop offset="1" stop-color="#6a6e66"/></linearGradient>
        <linearGradient id="${id}-rim" x2="0" y2="1"><stop stop-color="#f2f3ed"/><stop offset=".47" stop-color="#9d9f99"/><stop offset=".52" stop-color="#74776f"/><stop offset="1" stop-color="#d2d5ca"/></linearGradient>
        <linearGradient id="${id}-blade" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8b8e86"/><stop offset=".3" stop-color="#585c55"/><stop offset="1" stop-color="#373b34"/></linearGradient>
        <radialGradient id="${id}-screen"><stop stop-color="#363933"/><stop offset="1" stop-color="#1c1e1b"/></radialGradient>
        <linearGradient id="${id}-pins" x2="0" y2="1"><stop stop-color="#d8d9ae"/><stop offset="1" stop-color="#898b60"/></linearGradient>
      </defs>
      <ellipse cx="144" cy="235" rx="102" ry="6" fill="#282d24" opacity=".10"/>
      <g class="gpu-sleep-marks" data-gpu-expression="sleep-marks" fill="#797c75" font-family="Manrope,Arial,sans-serif" font-weight="500">
        <text class="gpu-z gpu-z-one" x="194" y="57" font-size="15">z</text><text class="gpu-z gpu-z-two" x="214" y="40" font-size="20">z</text><text class="gpu-z gpu-z-three" x="238" y="23" font-size="25">Z</text>
      </g>
      <path d="M38 209H250V219H203V227H89V219H38Z" fill="#444740" stroke="#6d7168" stroke-width="1"/>
      <path d="M91 219H201V230H91Z" fill="#4e514a"/>
      ${Array.from({length:18},(_,i)=>`<rect x="${95+i*5.8}" y="220" width="3.5" height="9" rx=".7" fill="url(#${id}-pins)"/>`).join('')}
      <path d="M27 81H260V207Q260 215 252 215H27Q19 215 19 207V89Q19 81 27 81Z" fill="url(#${id}-bevel)" stroke="#444740" stroke-width="1.4"/>
      <rect x="15" y="87" width="10" height="122" rx="2" fill="#808577" stroke="#3b3e38"/>
      <rect x="17" y="77" width="6" height="143" rx="2" fill="#d9dcd2" stroke="#6f736b" stroke-width="1"/>
      ${Array.from({length:7},(_,i)=>`<rect x="18.6" y="${96+i*15}" width="2.8" height="8" rx="1.3" fill="#797c74"/>`).join('')}
      <path d="M37 82H254Q262 82 262 90V198Q262 207 254 207H37Q29 207 29 198V90Q29 82 37 82Z" fill="url(#${id}-case)" stroke="#7c8076" stroke-width="1"/>
      <path d="M37 85H252Q258 85 259 92" fill="none" stroke="#fffef7" stroke-width="1.7"/>
      <path d="M34 195V198Q34 203 39 203H253" fill="none" stroke="#777a73" stroke-opacity=".65" stroke-width="1"/>
      <path d="M140 110H148V189H140Z" fill="#acaea7"/>
      <path d="M144 114V174" stroke="#f0f2e9" stroke-width="1"/>
      <path d="M52 93H111M178 93H237" stroke="#a3a69e" stroke-width="1"/>
      <text x="144" y="99" fill="#545751" text-anchor="middle" font-family="Manrope,Arial,sans-serif" font-size="8" font-weight="600" letter-spacing="1.3">OFFPEAK</text>
      ${fan(91)}${fan(197,true)}
      ${screw(38,91)}${screw(253,91)}${screw(38,196)}${screw(253,196)}
      <path d="M51 200l7-1m2-1 3-.8M232 85l7 .7M33 122v8" fill="none" stroke="#848780" stroke-width=".7" opacity=".68"/>
      <path d="M53 201h7m174-115 4 .4" stroke="#fffdf2" stroke-width=".7"/>
      <rect x="128" y="194" width="31" height="8" rx="3" fill="#464a43" stroke="#afb3a5" stroke-width=".8"/>
      <path d="M134 198H153" stroke="#aeb2a5" stroke-width="1" stroke-dasharray="1 2"/>
      <circle class="gpu-status-led" cx="243" cy="185" r="2.6" fill="#ccff00" opacity=".3"/>
      <g class="gpu-eyes gpu-face-sleep" data-gpu-expression="sleep" fill="none" stroke="#ccff00" stroke-width="3.1" stroke-linecap="round"><path d="M82 151Q91 157 100 151M188 151Q197 157 206 151"/></g>
      <g class="gpu-eyes gpu-face-wake" data-gpu-expression="wake" opacity="0" fill="#ccff00"><rect x="87" y="141" width="8" height="18" rx="4"/><rect x="193" y="141" width="8" height="18" rx="4"/></g>
      <g class="gpu-eyes gpu-face-check" data-gpu-expression="check" opacity="0" fill="none" stroke="#ccff00" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M88 145V156"/><path class="gpu-check-stroke" d="M188 151L194 157L205 144"/><path class="gpu-eye-scan" d="M80 162H102" stroke-width="1" opacity=".55"/></g>
      <g class="gpu-eyes gpu-face-happy" data-gpu-expression="happy" opacity="0" fill="none" stroke="#ccff00" stroke-width="3.3" stroke-linecap="round" stroke-linejoin="round"><path d="M82 153L91 144L100 153M188 153L197 144L206 153"/></g>
      <g class="gpu-eyes gpu-face-drowsy" data-gpu-expression="drowsy" opacity="0" fill="none" stroke="#ccff00" stroke-width="3" stroke-linecap="round"><path d="M82 151H100M188 151H206"/></g>
      <path class="gpu-mouth" d="M137 182Q144 188 151 182" fill="none" stroke="#585b53" stroke-width="1.9" stroke-linecap="round"/>
    </svg>`;
  }
  function mount(robot) {
    if (!robot || robot.dataset.gpuCompanion) return;
    robot.dataset.gpuCompanion = 'true';
    robot.querySelector('img')?.remove();
    robot.querySelector('.tech-robot-pulse')?.remove();
    robot.querySelector('.tech-robot-shadow')?.remove();
    // The conversation controller still updates its original topic hook.
    const oldCaption = robot.querySelector('.tech-robot-caption');
    if (oldCaption) oldCaption.hidden = true;
    robot.insertAdjacentHTML('afterbegin', artwork(`offpeak-gpu-${++serial}`));
    const caption = document.createElement('span');
    caption.className = 'gpu-companion-caption';
    caption.setAttribute('aria-hidden','true');
    caption.innerHTML = '<span class="gpu-caption-sleep">Idle capacity</span><span class="gpu-caption-wake">Waking up</span><span class="gpu-caption-check">Checking</span><span class="gpu-caption-happy">Ready for work</span><span class="gpu-caption-drowsy">Back to idle</span>';
    robot.append(caption);
  }
  function init() { document.querySelectorAll('#about .tech-robot').forEach(mount); }
  window.OffpeakGpuCompanion = {mount, artwork};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();

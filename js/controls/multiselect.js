// /js/controls/multiselect.js
// Lightweight reusable token-based multi-select with a searchable dropdown.
// Usage:
//   import { MultiSelect } from './controls/multiselect.js'
//   const ms = new MultiSelect(container, { options:[{value:'106', label:'106'}, ...], selected:['105','255'], placeholder:'Vehicle #' });
//   ms.get();           // -> ['105','255']
//   ms.set(['107']);    // programmatic set
//   ms.onChange(fn);    // subscribe to changes
//   ms.updateOptions([{value:'1',label:'1'}]); // replace option list
//
// The control injects its own minimal styles once per page.

const STYLE_ID = 'ms-token-select-styles';
function injectStyles(){
  if (document.getElementById(STYLE_ID)) return;
  const css = `
  .ms{ position:relative; display:flex; flex-wrap:wrap; gap:6px; padding:6px 8px; border:1px solid #CBD5E1; border-radius:10px; background:#fff; min-height:38px; cursor:text; }
  .ms:focus-within{ outline:2px solid #2563EB22; border-color:#2563EB; }
  .ms-token{ display:inline-flex; align-items:center; gap:6px; padding:4px 8px; background:#E6F4EA; border-radius:999px; font-size:13px; }
  .ms-x{ border:none; background:none; cursor:pointer; line-height:1; font-size:14px; padding:0 2px; opacity:.7; }
  .ms-x:hover{ opacity:1; }
  .ms-input{ flex:1 1 120px; min-width:120px; border:none; outline:none; font:inherit; padding:4px 2px; }
  .ms-clear{ position:absolute; top:6px; right:6px; width:24px; height:24px; display:flex; align-items:center; justify-content:center; border:none; background:#F1F5F9; border-radius:999px; cursor:pointer; }
  .ms-clear:hover{ background:#E2E8F0; }
  .ms-dd{ position:absolute; left:0; right:0; top:calc(100% + 6px); background:#fff; border:1px solid #CBD5E1; border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.08); max-height:260px; overflow:auto; z-index:30; }
  .ms-opt{ display:flex; align-items:center; gap:8px; padding:10px 12px; cursor:pointer; }
  .ms-opt:hover, .ms-opt[aria-selected="true"]{ background:#F1F5F9; }
  .ms-dot{ width:8px; height:8px; background:#10B981; border-radius:999px; }
  .ms-empty{ padding:10px 12px; color:#64748b; }
  `;
  const style = document.createElement('style'); style.id = STYLE_ID; style.textContent = css; document.head.appendChild(style);
}

export class MultiSelect{
  constructor(container, { options=[], selected=[], placeholder='Select...', maxChips=99 }={}){
    injectStyles();
    this.el = container;
    this.options = Array.isArray(options) ? options : [];
    this.selected = new Set((selected||[]).map(v=>String(v)));
    this.placeholder = placeholder;
    this.maxChips = maxChips;
    this.onChangeHandlers = [];

    this.build();
    this.render();
  }

  build(){
    this.el.classList.add('ms');
    this.chipsWrap = document.createElement('div');
    this.chipsWrap.className = 'ms-chips';
    this.input = document.createElement('input');
    this.input.className = 'ms-input';
    this.input.setAttribute('placeholder', this.placeholder);
    this.clearBtn = document.createElement('button');
    this.clearBtn.className = 'ms-clear';
    this.clearBtn.type = 'button';
    this.clearBtn.title = 'Clear';
    this.clearBtn.innerHTML = '×';

    this.dd = document.createElement('div');
    this.dd.className = 'ms-dd'; this.dd.style.display = 'none';

    this.el.appendChild(this.chipsWrap);
    this.el.appendChild(this.input);
    this.el.appendChild(this.clearBtn);
    this.el.appendChild(this.dd);

    // events
    this.el.addEventListener('click', () => this.input.focus());
    this.clearBtn.addEventListener('click', (e)=>{ e.stopPropagation(); this.set([]); });
    this.input.addEventListener('input', () => this.renderDropdown());
    this.input.addEventListener('keydown', (e)=>{
      if (e.key === 'Backspace' && !this.input.value && this.selected.size){
        // delete last token
        const last = Array.from(this.selected).pop();
        this.remove(last);
      } else if (e.key === 'ArrowDown'){
        e.preventDefault(); this.focusNextOption(1);
      } else if (e.key === 'ArrowUp'){
        e.preventDefault(); this.focusNextOption(-1);
      } else if (e.key === 'Enter'){
        const focused = this.dd.querySelector('.ms-opt[tabindex="0"]');
        if (focused){ e.preventDefault(); focused.click(); }
      } else if (e.key === 'Escape'){
        this.hideDropdown();
      }
    });
    document.addEventListener('click', (e)=>{
      if (!this.el.contains(e.target)) this.hideDropdown();
    });
  }

  updateOptions(options){ this.options = Array.isArray(options) ? options : []; this.renderDropdown(true); }
  onChange(fn){ if (typeof fn === 'function') this.onChangeHandlers.push(fn); }
  emit(){ this.onChangeHandlers.forEach(fn => fn(this.get())); }

  get(){ return Array.from(this.selected); }
  set(values){
    this.selected = new Set((values||[]).map(v=>String(v)));
    this.input.value = '';
    this.render();
    this.emit();
  }
  add(v){ v=String(v); if (this.selected.has(v)) return; this.selected.add(v); this.render(); this.emit(); }
  remove(v){ v=String(v); if (!this.selected.has(v)) return; this.selected.delete(v); this.render(); this.emit(); }

  render(){
    // chips
    this.chipsWrap.innerHTML = '';
    Array.from(this.selected).slice(0, this.maxChips).forEach(v => {
      const opt = this.options.find(o => String(o.value)===String(v));
      const label = opt?.label ?? String(v);
      const chip = document.createElement('span');
      chip.className = 'ms-token';
      chip.innerHTML = `${label}<button type="button" class="ms-x" aria-label="Remove">×</button>`;
      chip.querySelector('.ms-x').addEventListener('click', (e)=>{ e.stopPropagation(); this.remove(v); });
      this.chipsWrap.appendChild(chip);
    });
    this.renderDropdown();
  }

  filterOptions(){
    const q = this.input.value.trim().toLowerCase();
    const sel = this.selected;
    const base = this.options.filter(o => !sel.has(String(o.value)));
    if (!q) return base.slice(0, 250);
    return base.filter(o => String(o.label).toLowerCase().includes(q) || String(o.value).toLowerCase().includes(q)).slice(0, 250);
  }

  renderDropdown(forceOpen=false){
    const list = this.filterOptions();
    if (!forceOpen && !this.input.matches(':focus')){ this.hideDropdown(); return; }
    if (!list.length){
      this.dd.innerHTML = `<div class="ms-empty">No matches</div>`;
    }else{
      this.dd.innerHTML = list.map(o => `
        <div class="ms-opt" role="option" data-value="${String(o.value)}" tabindex="-1">
          <div class="ms-dot"></div>
          <div class="ms-label">${o.label ?? o.value}</div>
        </div>
      `).join('');
      // wire clicks
      this.dd.querySelectorAll('.ms-opt').forEach(el => {
        el.addEventListener('click', (e)=>{
          const v = el.getAttribute('data-value');
          this.add(v);
          this.input.focus();
        });
      });
    }
    this.showDropdown();
    // Set initial focus
    const first = this.dd.querySelector('.ms-opt');
    if (first){ first.setAttribute('tabindex', '0'); }
  }

  focusNextOption(step){
    const opts = Array.from(this.dd.querySelectorAll('.ms-opt'));
    if (!opts.length){ this.renderDropdown(true); return; }
    let idx = opts.findIndex(o => o.getAttribute('tabindex')==='0');
    if (idx === -1) idx = 0;
    opts[idx].setAttribute('tabindex','-1');
    let next = idx + step;
    if (next < 0) next = opts.length - 1;
    if (next >= opts.length) next = 0;
    opts[next].setAttribute('tabindex','0');
    opts[next].focus();
  }

  showDropdown(){ this.dd.style.display = 'block'; }
  hideDropdown(){ this.dd.style.display = 'none'; }
}

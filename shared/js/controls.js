/**
 * controls.js
 *
 * A tiny declarative form builder for the demo panel. Kept separate from the
 * map wiring so the interesting files (`examples/js/app.js`,
 * `studio/js/studio.js`) stay about waterlines rather than about DOM plumbing.
 */

/**
 * @typedef {Object} Field
 * @property {string} name
 * @property {string} label
 * @property {'range'|'select'|'checkbox'|'color'|'buttons'} type
 * @property {*} value
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {Array<{value:string,label:string,title?:string}>} [options]
 * @property {string} [hint]
 * @property {(v:number)=>string} [format]
 */

/**
 * @param {HTMLElement} root
 * @param {Field[]} fields
 * @param {(name:string, value:*, values:Object)=>void} onChange
 * @returns {{values:Object, set:(name:string,value:*)=>void, el:(name:string)=>HTMLElement}}
 */
export function buildPanel(root, fields, onChange) {
  const values = {};
  const inputs = new Map();

  for (const field of fields) {
    values[field.name] = field.value;
    const row = document.createElement('div');
    row.className = `field field--${field.type}`;

    if (field.type === 'buttons') {
      row.appendChild(labelEl(field));
      const group = document.createElement('div');
      group.className = 'buttons';
      for (const option of field.options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = option.label;
        button.dataset.value = option.value;
        if (option.title) button.title = option.title;
        button.className = option.value === field.value ? 'is-active' : '';
        button.addEventListener('click', () => {
          for (const sibling of group.children) sibling.classList.remove('is-active');
          button.classList.add('is-active');
          values[field.name] = option.value;
          onChange(field.name, option.value, values);
        });
        group.appendChild(button);
      }
      row.appendChild(group);
      inputs.set(field.name, group);
      root.appendChild(row);
      continue;
    }

    const input = createInput(field);
    inputs.set(field.name, input);

    if (field.type === 'checkbox') {
      const wrap = document.createElement('label');
      wrap.className = 'inline';
      wrap.appendChild(input);
      wrap.appendChild(document.createTextNode(field.label));
      row.appendChild(wrap);
    } else {
      const label = labelEl(field);
      if (field.type === 'range') {
        const readout = document.createElement('span');
        readout.className = 'readout';
        readout.textContent = formatValue(field, field.value);
        label.appendChild(readout);
        input.addEventListener('input', () => {
          readout.textContent = formatValue(field, Number(input.value));
        });
      }
      row.appendChild(label);
      row.appendChild(input);
    }

    if (field.hint) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = field.hint;
      row.appendChild(hint);
    }

    input.addEventListener('input', () => {
      const value = readInput(field, input);
      values[field.name] = value;
      onChange(field.name, value, values);
    });

    root.appendChild(row);
  }

  return {
    values,
    el: (name) => inputs.get(name),
    set(name, value) {
      const input = inputs.get(name);
      values[name] = value;
      if (!input) return;
      if (input.type === 'checkbox') input.checked = !!value;
      else if ('value' in input) input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: false }));
    },
  };
}

/**
 * Group fields under a collapsible heading.
 *
 * @param {HTMLElement} root
 * @param {string} title
 * @param {boolean} [open=true]
 * @returns {HTMLElement} the body to pass to {@link buildPanel}
 */
export function section(root, title, open = true) {
  const details = document.createElement('details');
  details.className = 'section';
  details.open = open;
  const summary = document.createElement('summary');
  summary.textContent = title;
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'section__body';
  details.appendChild(body);
  root.appendChild(details);
  return body;
}

function labelEl(field) {
  const label = document.createElement('label');
  label.className = 'label';
  const text = document.createElement('span');
  text.textContent = field.label;
  label.appendChild(text);
  return label;
}

function createInput(field) {
  if (field.type === 'select') {
    const select = document.createElement('select');
    for (const option of field.options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      if (option.title) el.title = option.title;
      select.appendChild(el);
    }
    select.value = field.value;
    return select;
  }
  const input = document.createElement('input');
  input.type = field.type;
  if (field.type === 'range') {
    input.min = field.min;
    input.max = field.max;
    input.step = field.step ?? 1;
    input.value = field.value;
  } else if (field.type === 'checkbox') {
    input.checked = !!field.value;
  } else {
    input.value = field.value;
  }
  return input;
}

function readInput(field, input) {
  if (field.type === 'range') return Number(input.value);
  if (field.type === 'checkbox') return input.checked;
  return input.value;
}

function formatValue(field, value) {
  return field.format ? field.format(value) : String(value);
}

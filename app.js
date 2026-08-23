// ==========================================
// TABLA DE TERMISTORES 2.0 - APP.JS
// Motor completo: IndexedDB, Steinhart-Hart, Interpolación, Clientes
// ==========================================

const DB_NAME = 'TermistoresDB';
const DB_VERSION = 1;
let db;

// ==========================================
// 1. INICIALIZACIÓN DE BASE DE DATOS
// ==========================================
const initDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('clients')) {
                db.createObjectStore('clients', { keyPath: 'id', autoIncrement: true });
            }
            if (!db.objectStoreNames.contains('tables')) {
                db.createObjectStore('tables', { keyPath: 'name' });
            }
        };
        
        request.onsuccess = (event) => {
            db = event.target.result;
            seedDefaultTables();
            resolve(db);
        };
        
        request.onerror = (event) => reject(event.target.error);
    });
};

// Generar tabla NTC usando ecuación Beta
function generateNTCTable(R25, Beta) {
    const table = [];
    const T25 = 298.15;
    for (let T = -40; T <= 150; T += 1) {
        const TK = T + 273.15;
        const R = R25 * Math.exp(Beta * (1/TK - 1/T25));
        table.push({ t: T, r: Math.round(R * 1000) / 1000 });
    }
    return table;
}

const defaultTables = {
    'NTC 5K': generateNTCTable(5000, 3950),
    'NTC 10K': generateNTCTable(10000, 3950),
    'NTC 15K': generateNTCTable(15000, 3950),
    'NTC 20K': generateNTCTable(20000, 3950)
};

const seedDefaultTables = () => {
    const tx = db.transaction(['tables'], 'readwrite');
    const store = tx.objectStore('tables');
    
    Object.keys(defaultTables).forEach(name => {
        const checkReq = store.get(name);
        checkReq.onsuccess = () => {
            if (!checkReq.result) {
                store.add({ name: name, data: defaultTables[name] });
            }
        };
    });
};

// ==========================================
// 2. MOTOR DE CÁLCULO
// ==========================================
const calcEngine = {
    tempToRes: (tC, A, B, C) => {
        const T = tC + 273.15;
        let R = 10000;
        for (let i = 0; i < 10; i++) {
            const lnR = Math.log(R);
            const f = A + B * lnR + C * Math.pow(lnR, 3) - 1 / T;
            const df = B / R + 3 * C * Math.pow(lnR, 2) / R;
            R = R - f / df;
            if (R <= 0) R = 0.001;
        }
        return R;
    },
    
    resToTemp: (R, A, B, C) => {
        if (R <= 0) return -273.15;
        const lnR = Math.log(R);
        const T = 1 / (A + B * lnR + C * Math.pow(lnR, 3));
        return T - 273.15;
    },
    
    interpolate: (value, tableData, mode) => {
        const sorted = mode === 'R_to_T' 
            ? [...tableData].sort((a, b) => a.r - b.r)
            : [...tableData].sort((a, b) => a.t - b.t);
        
        const key = mode === 'R_to_T' ? 'r' : 't';
        const targetKey = mode === 'R_to_T' ? 't' : 'r';

        if (value < sorted[0][key] || value > sorted[sorted.length - 1][key]) {
            return { error: 'Fuera de rango de la tabla' };
        }

        for (let i = 0; i < sorted.length - 1; i++) {
            if (value >= sorted[i][key] && value <= sorted[i + 1][key]) {
                const x1 = sorted[i][key], x2 = sorted[i + 1][key];
                const y1 = sorted[i][targetKey], y2 = sorted[i + 1][targetKey];
                const result = y1 + (value - x1) * (y2 - y1) / (x2 - x1);
                return { value: result, error: null };
            }
        }
        return { error: 'No se pudo interpolar' };
    }
};

// ==========================================
// 3. ESTADO GLOBAL
// ==========================================
let currentMode = 'steinhart';
let currentTable = null;

// ==========================================
// 4. INICIALIZACIÓN
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    setupNavigation();
    setupConverter();
    setupClients();
    setupSearch();
    setupTables();
    loadTablesToSelect();
    setupTheme();
});

// ==========================================
// 5. NAVEGACIÓN
// ==========================================
function setupNavigation() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.view).classList.add('active');
            window.scrollTo(0, 0);
        });
    });
}

function setupTheme() {
    const toggle = document.getElementById('theme-toggle');
    toggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const newTheme = current === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        toggle.textContent = newTheme === 'light' ? '🌙' : '☀️';
    });
}

// ==========================================
// 6. CONVERSOR
// ==========================================
function setupConverter() {
    // Botones de acceso rápido
    document.querySelectorAll('.quick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const r = parseFloat(btn.dataset.r);
            document.getElementById('input-res').value = (r / 1000).toFixed(3);
            calculateFromRes();
        });
    });

    // Slider de temperatura
    const slider = document.getElementById('temp-slider');
    const tempInput = document.getElementById('input-temp');
    
    slider.addEventListener('input', () => {
        tempInput.value = parseFloat(slider.value).toFixed(1);
        calculateFromTemp();
    });

    tempInput.addEventListener('input', () => {
        const val = parseFloat(tempInput.value);
        if (!isNaN(val)) {
            slider.value = val;
            calculateFromTemp();
        }
    });

    document.getElementById('input-res').addEventListener('input', calculateFromRes);

    // Botón limpiar
    document.getElementById('btn-clear').addEventListener('click', () => {
        tempInput.value = '25.0';
        slider.value = 25;
        document.getElementById('input-res').value = '10.000';
        hideAlert();
    });

    // Botón invertir
    document.getElementById('btn-invert').addEventListener('click', () => {
        const temp = tempInput.value;
        const res = document.getElementById('input-res').value;
        tempInput.value = res;
        document.getElementById('input-res').value = temp;
    });

    // Selector de modo
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.calc-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.mode + '-panel').classList.add('active');
            currentMode = btn.dataset.mode;
            if (currentMode === 'interpolation') loadTablesToSelect();
        });
    });
}

function calculateFromTemp() {
    const tC = parseFloat(document.getElementById('input-temp').value);
    hideAlert();
    if (isNaN(tC)) return;

    if (currentMode === 'steinhart') {
        const A = parseFloat(document.getElementById('sh-a').value);
        const B = parseFloat(document.getElementById('sh-b').value);
        const C = parseFloat(document.getElementById('sh-c').value);
        const R = calcEngine.tempToRes(tC, A, B, C);
        document.getElementById('input-res').value = (R / 1000).toFixed(3);
    } else {
        const tableName = document.getElementById('lut-table-select').value;
        if (!tableName) return;
        getTable(tableName, (table) => {
            const res = calcEngine.interpolate(tC, table.data, 'T_to_R');
            if (res.error) {
                showAlert(res.error, 'error');
            } else {
                document.getElementById('input-res').value = (res.value / 1000).toFixed(3);
            }
        });
    }
}

function calculateFromRes() {
    const R_k = parseFloat(document.getElementById('input-res').value);
    hideAlert();
    if (isNaN(R_k)) return;
    const R = R_k * 1000;

    if (currentMode === 'steinhart') {
        const A = parseFloat(document.getElementById('sh-a').value);
        const B = parseFloat(document.getElementById('sh-b').value);
        const C = parseFloat(document.getElementById('sh-c').value);
        const tC = calcEngine.resToTemp(R, A, B, C);
        document.getElementById('input-temp').value = tC.toFixed(1);
        document.getElementById('temp-slider').value = tC;
    } else {
        const tableName = document.getElementById('lut-table-select').value;
        if (!tableName) return;
        getTable(tableName, (table) => {
            const res = calcEngine.interpolate(R, table.data, 'R_to_T');
            if (res.error) {
                showAlert(res.error, 'error');
            } else {
                document.getElementById('input-temp').value = res.value.toFixed(1);
                document.getElementById('temp-slider').value = res.value;
            }
        });
    }
}

function showAlert(msg, type) {
    const alertBox = document.getElementById('conversion-alert');
    if (!alertBox) return;
    alertBox.textContent = msg;
    alertBox.className = `alert ${type}`;
}

function hideAlert() {
    const alertBox = document.getElementById('conversion-alert');
    if (alertBox) alertBox.className = 'alert hidden';
}

// ==========================================
// 7. CLIENTES
// ==========================================
function setupClients() {
    document.getElementById('new-client-btn').addEventListener('click', () => {
        clearClientForm();
    });

    document.getElementById('btn-save').addEventListener('click', saveClient);
    document.getElementById('btn-delete').addEventListener('click', deleteCurrentClient);

    // Toggle ON/OFF - INVERTER
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
}

function clearClientForm() {
    document.getElementById('client-name').value = '';
    document.getElementById('client-phone').value = '';
    document.getElementById('client-email').value = '';
    document.getElementById('equipment-name').value = '';
    document.getElementById('client-note').value = '';
    document.getElementById('therm-int-1').value = '10.0';
    document.getElementById('therm-int-1-temp').value = '25.0';
    document.getElementById('therm-int-2').value = '15.0';
    document.getElementById('therm-int-2-temp').value = '20.0';
    document.getElementById('therm-ext-1').value = '5.0';
    document.getElementById('therm-ext-1-temp').value = '30.0';
    document.getElementById('therm-ext-2').value = '10.0';
    document.getElementById('therm-ext-2-temp').value = '28.0';
}

function saveClient() {
    const name = document.getElementById('client-name').value.trim();
    const phone = document.getElementById('client-phone').value.trim();
    const email = document.getElementById('client-email').value.trim();
    const equipment = document.getElementById('equipment-name').value.trim();
    const note = document.getElementById('client-note').value.trim();
    const equipmentType = document.querySelector('.toggle-btn.active')?.dataset.type || 'inverter';

    if (!name || !phone) {
        alert('Nombre y Teléfono son obligatorios');
        return;
    }

    const clientData = {
        name, phone, email, equipment, equipmentType, note,
        thermistors: {
            int1: { r: document.getElementById('therm-int-1').value, t: document.getElementById('therm-int-1-temp').value },
            int2: { r: document.getElementById('therm-int-2').value, t: document.getElementById('therm-int-2-temp').value },
            ext1: { r: document.getElementById('therm-ext-1').value, t: document.getElementById('therm-ext-1-temp').value },
            ext2: { r: document.getElementById('therm-ext-2').value, t: document.getElementById('therm-ext-2-temp').value }
        },
        createdAt: new Date().toISOString()
    };

    const tx = db.transaction(['clients'], 'readwrite');
    tx.objectStore('clients').add(clientData);
    tx.oncomplete = () => {
        alert('✅ Cliente guardado correctamente');
        clearClientForm();
    };
    tx.onerror = () => alert('Error al guardar el cliente');
}

function deleteCurrentClient() {
    if (confirm('¿Está seguro de eliminar este cliente? Esta acción no se puede deshacer.')) {
        alert('Función de eliminación - implementar con ID de cliente');
    }
}

// ==========================================
// 8. BUSCADOR
// ==========================================
function setupSearch() {
    const searchInput = document.getElementById('global-search');
    const resultsContainer = document.getElementById('search-results');

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        resultsContainer.innerHTML = '';
        
        if (query.length < 2) return;

        const tx = db.transaction(['clients'], 'readonly');
        tx.objectStore('clients').getAll().onsuccess = (ev) => {
            const matches = ev.target.result.filter(c => 
                c.name.toLowerCase().includes(query) || 
                c.phone.includes(query) ||
                (c.equipment && c.equipment.toLowerCase().includes(query))
            );

            if (matches.length === 0) {
                resultsContainer.innerHTML = '<p class="empty-state">No se encontraron resultados</p>';
                return;
            }

            matches.forEach(c => {
                const div = document.createElement('div');
                div.className = 'result-item';
                div.innerHTML = `
                    <span class="result-icon">🔍</span>
                    <div class="result-info">
                        <strong>${c.name}</strong>
                        <small>${c.phone} • ${c.equipment || 'Sin equipo'}</small>
                    </div>
                `;
                div.addEventListener('click', () => loadClientToForm(c));
                resultsContainer.appendChild(div);
            });
        };
    });
}

function loadClientToForm(client) {
    document.getElementById('client-name').value = client.name || '';
    document.getElementById('client-phone').value = client.phone || '';
    document.getElementById('client-email').value = client.email || '';
    document.getElementById('equipment-name').value = client.equipment || '';
    document.getElementById('client-note').value = client.note || '';
    
    if (client.thermistors) {
        document.getElementById('therm-int-1').value = client.thermistors.int1?.r || '0.0';
        document.getElementById('therm-int-1-temp').value = client.thermistors.int1?.t || '0.0';
        document.getElementById('therm-int-2').value = client.thermistors.int2?.r || '0.0';
        document.getElementById('therm-int-2-temp').value = client.thermistors.int2?.t || '0.0';
        document.getElementById('therm-ext-1').value = client.thermistors.ext1?.r || '0.0';
        document.getElementById('therm-ext-1-temp').value = client.thermistors.ext1?.t || '0.0';
        document.getElementById('therm-ext-2').value = client.thermistors.ext2?.r || '0.0';
        document.getElementById('therm-ext-2-temp').value = client.thermistors.ext2?.t || '0.0';
    }

    // Cambiar a vista de clientes
    document.querySelector('[data-view="view-clientes"]').click();
}

// ==========================================
// 9. TABLAS
// ==========================================
function setupTables() {
    document.getElementById('csv-upload').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const lines = event.target.result.split('\n');
            const data = [];
            lines.forEach(line => {
                const parts = line.split(',').map(v => parseFloat(v.trim()));
                if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                    data.push({ r: parts[0], t: parts[1] });
                }
            });
            if (data.length > 0) {
                const tx = db.transaction(['tables'], 'readwrite');
                tx.objectStore('tables').put({ name: file.name.replace('.csv', ''), data });
                tx.oncomplete = () => {
                    alert('✅ Tabla importada correctamente');
                    renderTables();
                    loadTablesToSelect();
                };
            }
        };
        reader.readAsText(file);
    });

    // Click en items de tabla
    document.querySelectorAll('.table-item').forEach(item => {
        item.addEventListener('click', () => {
            const name = item.querySelector('h3').textContent;
            getTable(name, (table) => {
                if (table) {
                    alert(`Tabla: ${table.name}\nPuntos: ${table.data.length}\nRango: ${table.data[0].t}°C a ${table.data[table.data.length-1].t}°C`);
                }
            });
        });
    });
}

function renderTables() {
    const tx = db.transaction(['tables'], 'readonly');
    tx.objectStore('tables').getAll().onsuccess = (e) => {
        const container = document.getElementById('tables-list');
        container.innerHTML = '';
        e.target.result.forEach(t => {
            const div = document.createElement('div');
            div.className = 'table-item';
            div.innerHTML = `
                <div class="table-info">
                    <h3>${t.name}</h3>
                    <p>Tabla completa -40°C a 150°C</p>
                </div>
                <button class="table-btn">›</button>
            `;
            container.appendChild(div);
        });
    };
}

function loadTablesToSelect() {
    const tx = db.transaction(['tables'], 'readonly');
    tx.objectStore('tables').getAll().onsuccess = (e) => {
        const select = document.getElementById('lut-table-select');
        if (!select) return;
        select.innerHTML = '<option value="">-- Seleccione una tabla --</option>';
        e.target.result.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.name;
            opt.textContent = t.name;
            select.appendChild(opt);
        });
        if (e.target.result.length > 0) {
            select.value = e.target.result[0].name;
            currentTable = e.target.result[0];
        }
    };
}

function getTable(name, callback) {
    const tx = db.transaction(['tables'], 'readonly');
    tx.objectStore('tables').get(name).onsuccess = (e) => callback(e.target.result);
}

// ==========================================
// 1. CONFIGURACIÓN E INDEXEDDB
// ==========================================
const DB_NAME = 'TermistoresDB';
const DB_VERSION = 1;

let db;

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

// Tablas completas de termistores NTC Beta 3950
const defaultTables = {
    'NTC 5K': generateNTCTable(5000, 3950),
    'NTC 10K': generateNTCTable(10000, 3950),
    'NTC 15K': generateNTCTable(15000, 3950),
    'NTC 20K': generateNTCTable(20000, 3950)
};

// Generar tabla NTC usando ecuación Beta
function generateNTCTable(R25, Beta) {
    const table = [];
    const T25 = 298.15; // 25°C en Kelvin
    const R0 = R25;
    
    for (let T = -50; T <= 150; T += 5) {
        const TK = T + 273.15;
        // Ecuación Beta: R = R25 * exp(Beta * (1/T - 1/T25))
        const R = R0 * Math.exp(Beta * (1/TK - 1/T25));
        table.push({ t: T, r: Math.round(R) });
    }
    return table;
}

const seedDefaultTables = () => {
    const transaction = db.transaction(['tables'], 'readwrite');
    const store = transaction.objectStore('tables');
    
    Object.keys(defaultTables).forEach(name => {
        store.get(name).onsuccess = (event) => {
            if (!event.target.result) {
                store.add({
                    name: name,
                    data: defaultTables[name]
                });
            }
        };
    });
};

// ==========================================
// 2. MOTOR DE CÁLCULO
// ==========================================
const calcEngine = {
    // Steinhart-Hart
    tempToRes: (tC, A, B, C) => {
        const T = tC + 273.15;
        let R = 10000;
        for (let i = 0; i < 5; i++) {
            const lnR = Math.log(R);
            const f = A + B * lnR + C * Math.pow(lnR, 3) - 1 / T;
            const df = B / R + 3 * C * Math.pow(lnR, 2) / R;
            R = R - f / df;
        }
        return R;
    },
    
    resToTemp: (R, A, B, C) => {
        const lnR = Math.log(R);
        const T = 1 / (A + B * lnR + C * Math.pow(lnR, 3));
        return T - 273.15;
    },
    
    // Interpolación lineal
    interpolate: (value, tableData, mode) => {
        const sorted = mode === 'R_to_T' 
            ? [...tableData].sort((a, b) => a.r - b.r)
            : [...tableData].sort((a, b) => a.t - b.t);
        
        const key = mode === 'R_to_T' ? 'r' : 't';
        const targetKey = mode === 'R_to_T' ? 't' : 'r';

        if (value < sorted[0][key] || value > sorted[sorted.length - 1][key]) {
            return { error: 'Fuera de rango' };
        }

        for (let i = 0; i < sorted.length - 1; i++) {
            if (value >= sorted[i][key] && value <= sorted[i + 1][key]) {
                const x1 = sorted[i][key], x2 = sorted[i + 1][key];
                const y1 = sorted[i][targetKey], y2 = sorted[i + 1][targetKey];
                const result = y1 + (value - x1) * (y2 - y1) / (x2 - x1);
                return { value: result, error: null };
            }
        }
        return { error: 'Error' };
    }
};

// ==========================================
// 3. GESTIÓN DE UI
// ==========================================
let currentMode = 'steinhart';

document.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    setupNavigation();
    setupConverter();
    setupClients();
    setupTables();
    loadTablesToSelect();
});

function setupNavigation() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.view).classList.add('active');
            
            if (btn.dataset.view === 'view-clientes') renderClients();
            if (btn.dataset.view === 'view-tablas') renderTables();
        });
    });

    document.getElementById('theme-toggle').addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        document.documentElement.setAttribute('data-theme', current === 'light' ? 'dark' : 'light');
    });
}

function setupConverter() {
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

    // Botones rápidos de kΩ
    document.querySelectorAll('.quick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('input-res').value = btn.dataset.r;
            calculateFromRes();
        });
    });

    document.getElementById('input-temp').addEventListener('input', calculateFromTemp);
    document.getElementById('input-res').addEventListener('input', calculateFromRes);
}

function calculateFromTemp() {
    const tC = parseFloat(document.getElementById('input-temp').value);
    const alertBox = document.getElementById('conversion-alert');
    alertBox.classList.add('hidden');

    if (isNaN(tC)) return;

    if (currentMode === 'steinhart') {
        const A = parseFloat(document.getElementById('sh-a').value);
        const B = parseFloat(document.getElementById('sh-b').value);
        const C = parseFloat(document.getElementById('sh-c').value);
        const R = calcEngine.tempToRes(tC, A, B, C);
        document.getElementById('input-res').value = R.toFixed(1);
    } else {
        const tableName = document.getElementById('lut-table-select').value;
        if (!tableName) return;
        getTable(tableName, (table) => {
            const res = calcEngine.interpolate(tC, table.data, 'T_to_R');
            if (res.error) {
                showAlert(res.error, 'error');
            } else {
                document.getElementById('input-res').value = res.value.toFixed(1);
            }
        });
    }
}

function calculateFromRes() {
    const R = parseFloat(document.getElementById('input-res').value);
    const alertBox = document.getElementById('conversion-alert');
    alertBox.classList.add('hidden');

    if (isNaN(R)) return;

    if (currentMode === 'steinhart') {
        const A = parseFloat(document.getElementById('sh-a').value);
        const B = parseFloat(document.getElementById('sh-b').value);
        const C = parseFloat(document.getElementById('sh-c').value);
        const tC = calcEngine.resToTemp(R, A, B, C);
        document.getElementById('input-temp').value = tC.toFixed(1);
    } else {
        const tableName = document.getElementById('lut-table-select').value;
        if (!tableName) return;
        getTable(tableName, (table) => {
            const res = calcEngine.interpolate(R, table.data, 'R_to_T');
            if (res.error) {
                showAlert(res.error, 'error');
            } else {
                document.getElementById('input-temp').value = res.value.toFixed(1);
            }
        });
    }
}

function showAlert(msg, type) {
    const alertBox = document.getElementById('conversion-alert');
    alertBox.textContent = msg;
    alertBox.className = `alert ${type}`;
    alertBox.classList.remove('hidden');
}

// ==========================================
// 4. CLIENTES
// ==========================================
function setupClients() {
    document.getElementById('new-client-btn').addEventListener('click', () => {
        document.getElementById('client-id').value = '';
        document.getElementById('client-name').value = '';
        document.getElementById('client-phone').value = '';
        document.getElementById('client-address').value = '';
        document.getElementById('client-modal').classList.remove('hidden');
    });

    document.getElementById('cancel-client').addEventListener('click', () => {
        document.getElementById('client-modal').classList.add('hidden');
    });

    document.getElementById('save-client').addEventListener('click', () => {
        const id = document.getElementById('client-id').value;
        const name = document.getElementById('client-name').value.trim();
        const phone = document.getElementById('client-phone').value.trim();
        const address = document.getElementById('client-address').value.trim();

        if (!name || !phone) {
            alert('Nombre y Teléfono son obligatorios');
            return;
        }

        const tx = db.transaction(['clients'], 'readonly');
        const store = tx.objectStore('clients');
        const request = store.getAll();
        
        request.onsuccess = () => {
            const clients = request.result;
            const duplicate = clients.find(c => 
                c.name.toLowerCase() === name.toLowerCase() && c.phone === phone
            );
            
            if (duplicate && !id) {
                alert('⚠️ Ya existe un cliente con este Nombre y Teléfono');
                return;
            }

            const clientData = { name, phone, address };
            if (id) clientData.id = parseInt(id);

            const txWrite = db.transaction(['clients'], 'readwrite');
            txWrite.objectStore('clients').put(clientData);
            txWrite.oncomplete = () => {
                document.getElementById('client-modal').classList.add('hidden');
                renderClients();
            };
        };
    });
}

function renderClients() {
    const tx = db.transaction(['clients'], 'readonly');
    const store = tx.objectStore('clients');
    const request = store.getAll();
    
    request.onsuccess = () => {
        const container = document.getElementById('clients-list');
        container.innerHTML = '';
        request.result.forEach(c => {
            const div = document.createElement('div');
            div.className = 'card';
            div.innerHTML = `
                <div>
                    <strong>${c.name}</strong><br>
                    <small>${c.phone}</small><br>
                    <small>${c.address || 'Sin dirección'}</small>
                </div>
                <div class="card-actions">
                    <button class="secondary-btn" onclick="editClient(${c.id})">Editar</button>
                    <button class="secondary-btn" style="color:var(--danger)" onclick="deleteClient(${c.id})">Borrar</button>
                </div>
            `;
            container.appendChild(div);
        });
    };
}

window.editClient = (id) => {
    const tx = db.transaction(['clients'], 'readonly');
    tx.objectStore('clients').get(id).onsuccess = (e) => {
        const c = e.target.result;
        document.getElementById('client-id').value = c.id;
        document.getElementById('client-name').value = c.name;
        document.getElementById('client-phone').value = c.phone;
        document.getElementById('client-address').value = c.address || '';
        document.getElementById('client-modal').classList.remove('hidden');
    };
};

window.deleteClient = (id) => {
    if (confirm('¿Está seguro de eliminar este cliente?')) {
        const tx = db.transaction(['clients'], 'readwrite');
        tx.objectStore('clients').delete(id);
        tx.oncomplete = () => renderClients();
    }
};

// ==========================================
// 5. BUSCADOR Y TABLAS
// ==========================================
document.getElementById('global-search').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const container = document.getElementById('search-results');
    container.innerHTML = '';
    if (query.length < 2) return;

    const tx = db.transaction(['clients'], 'readonly');
    tx.objectStore('clients').getAll().onsuccess = (ev) => {
        ev.target.result.filter(c => 
            c.name.toLowerCase().includes(query) || 
            c.phone.includes(query)
        ).forEach(c => {
            const div = document.createElement('div');
            div.className = 'card';
            div.innerHTML = `<div><strong>${c.name}</strong><br><small>${c.phone}</small></div>`;
            div.onclick = () => {
                document.querySelector('[data-view="view-clientes"]').click();
                setTimeout(() => editClient(c.id), 100);
            };
            container.appendChild(div);
        });
    };
});

function setupTables() {
    document.getElementById('csv-upload').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const lines = event.target.result.split('\n');
            const data = [];
            lines.forEach(line => {
                const [r, t] = line.split(',').map(v => parseFloat(v.trim()));
                if (!isNaN(r) && !isNaN(t)) data.push({ r, t });
            });
            if (data.length > 0) {
                const tx = db.transaction(['tables'], 'readwrite');
                tx.objectStore('tables').put({ name: file.name.replace('.csv', ''), data });
                tx.oncomplete = () => {
                    alert('Tabla importada');
                    renderTables();
                    loadTablesToSelect();
                };
            }
        };
        reader.readAsText(file);
    });
}

function renderTables() {
    const tx = db.transaction(['tables'], 'readonly');
    tx.objectStore('tables').getAll().onsuccess = (e) => {
        const container = document.getElementById('tables-list');
        container.innerHTML = '';
        e.target.result.forEach(t => {
            const div = document.createElement('div');
            div.className = 'card';
            div.innerHTML = `<div><strong>${t.name}</strong><br><small>${t.data.length} puntos</small></div>`;
            container.appendChild(div);
        });
    };
}

function loadTablesToSelect() {
    const tx = db.transaction(['tables'], 'readonly');
    tx.objectStore('tables').getAll().onsuccess = (e) => {
        const select = document.getElementById('lut-table-select');
        select.innerHTML = '';
        e.target.result.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.name;
            opt.textContent = t.name;
            select.appendChild(opt);
        });
    };
}

function getTable(name, callback) {
    const tx = db.transaction(['tables'], 'readonly');
    tx.objectStore('tables').get(name).onsuccess = (e) => callback(e.target.result);
}

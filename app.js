// ==========================================
// TABLA DE TERMISTORES 2.0 - APP.JS
// ==========================================

const DB_NAME = 'TermistoresDB';
const DB_VERSION = 1;
let db = null;
let currentR25 = 10000; // Valor nominal actual
let currentMode = 'steinhart';

// ==========================================
// 1. INICIALIZACIÓN
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initDB();
        setupNavigation();
        setupConverter();
        setupClients();
        setupSearch();
        setupTables();
        await loadTablesToSelect();
        setupTheme();
        
        // Seleccionar 10K por defecto
        setTimeout(() => {
            const btn10K = document.querySelector('.quick-btn[data-r="10000"]');
            if (btn10K) btn10K.click();
        }, 200);
        
        console.log('✅ Aplicación inicializada correctamente');
    } catch (error) {
        console.error('❌ Error en inicialización:', error);
    }
});

// ==========================================
// 2. BASE DE DATOS INDEXEDDB
// ==========================================
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => {
            console.error('Error al abrir BD:', request.error);
            reject(request.error);
        };
        
        request.onsuccess = () => {
            db = request.result;
            console.log('✅ BD abierta correctamente');
            seedDefaultTables();
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            
            if (!database.objectStoreNames.contains('clients')) {
                database.createObjectStore('clients', { keyPath: 'id', autoIncrement: true });
                console.log('📦 Store clients creado');
            }
            
            if (!database.objectStoreNames.contains('tables')) {
                database.createObjectStore('tables', { keyPath: 'name' });
                console.log('📦 Store tables creado');
            }
        };
    });
}

// ==========================================
// 3. TABLAS POR DEFECTO
// ==========================================
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

function seedDefaultTables() {
    if (!db) return;
    
    const tx = db.transaction(['tables'], 'readwrite');
    const store = tx.objectStore('tables');
    
    Object.keys(defaultTables).forEach(name => {
        const getRequest = store.get(name);
        getRequest.onsuccess = () => {
            if (!getRequest.result) {
                store.add({
                    name: name,
                    data: defaultTables[name]
                });
                console.log(`📊 Tabla ${name} creada`);
            }
        };
    });
}

// ==========================================
// 4. MOTOR DE CÁLCULO
// ==========================================
const calcEngine = {
    calculateCoefficients: (T1, R1, T2, R2, T3, R3) => {
        const L1 = Math.log(R1);
        const L2 = Math.log(R2);
        const L3 = Math.log(R3);
        const Y1 = 1 / (T1 + 273.15);
        const Y2 = 1 / (T2 + 273.15);
        const Y3 = 1 / (T3 + 273.15);
        
        const A = (L2 * L3 * (L2 - L3) * Y1 + 
                   L3 * L1 * (L3 - L1) * Y2 + 
                   L1 * L2 * (L1 - L2) * Y3) / 
                  ((L1 - L3) * (L1 - L2) * (L2 - L3));
        
        const B = ((L2 - L3) * Y1 + 
                   (L3 - L1) * Y2 + 
                   (L1 - L2) * Y3) / 
                  ((L1 - L3) * (L1 - L2) * (L2 - L3));
        
        const C = ((L3 - L2) * Y1 + 
                   (L1 - L3) * Y2 + 
                   (L2 - L1) * Y3) / 
                  ((L1 - L3) * (L1 - L2) * (L2 - L3));
        
        return { A, B, C };
    },
    
    tempToRes: (tC, A, B, C) => {
        const T = tC + 273.15;
        const Y = 1 / T;
        let R = currentR25;
        
        for (let i = 0; i < 20; i++) {
            const lnR = Math.log(R);
            const f = A + B * lnR + C * Math.pow(lnR, 3) - Y;
            const df = (B + 3 * C * lnR * lnR) / R;
            
            if (Math.abs(df) < 1e-15) break;
            
            const Rnew = R - f / df;
            if (Math.abs(Rnew - R) < 0.001) break;
            R = Math.max(Rnew, 0.001);
        }
        return R;
    },
    
    resToTemp: (R, A, B, C) => {
        if (R <= 0) return -273.15;
        const lnR = Math.log(R);
        const invT = A + B * lnR + C * Math.pow(lnR, 3);
        if (Math.abs(invT) < 1e-15) return -273.15;
        const T = 1 / invT;
        return T - 273.15;
    },
    
    interpolate: (value, tableData, mode) => {
        if (!tableData || tableData.length === 0) {
            return { error: 'Tabla vacía', value: null };
        }
        
        const sorted = mode === 'R_to_T' 
            ? [...tableData].sort((a, b) => a.r - b.r)
            : [...tableData].sort((a, b) => a.t - b.t);
        
        const key = mode === 'R_to_T' ? 'r' : 't';
        const targetKey = mode === 'R_to_T' ? 't' : 'r';

        if (value < sorted[0][key]) {
            return { error: `Mín: ${sorted[0][key].toFixed(1)}`, value: null };
        }
        if (value > sorted[sorted.length - 1][key]) {
            return { error: `Máx: ${sorted[sorted.length - 1][key].toFixed(1)}`, value: null };
        }

        for (let i = 0; i < sorted.length - 1; i++) {
            if (value >= sorted[i][key] && value <= sorted[i + 1][key]) {
                const x1 = sorted[i][key];
                const x2 = sorted[i + 1][key];
                const y1 = sorted[i][targetKey];
                const y2 = sorted[i + 1][targetKey];
                
                if (Math.abs(x2 - x1) < 1e-10) {
                    return { error: null, value: y1 };
                }
                
                const result = y1 + (value - x1) * (y2 - y1) / (x2 - x1);
                return { error: null, value: result };
            }
        }
        
        return { error: 'No interpolable', value: null };
    }
};

// ==========================================
// 5. NAVEGACIÓN
// ==========================================
function setupNavigation() {
    const navBtns = document.querySelectorAll('.nav-btn');
    navBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            navBtns.forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            
            this.classList.add('active');
            const viewId = this.getAttribute('data-view');
            document.getElementById(viewId).classList.add('active');
            window.scrollTo(0, 0);
        });
    });
}

function setupTheme() {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    
    toggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const newTheme = current === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        toggle.textContent = newTheme === 'light' ? '🌙' : '☀️';
    });
}

// ==========================================
// 6. CONVERSOR - CORREGIDO
// ==========================================
function setupConverter() {
    // Botones de acceso rápido (5K, 10K, 15K, 20K)
const quickBtns = document.querySelectorAll('.quick-btn');
quickBtns.forEach(btn => {
    btn.addEventListener('click', function() {
        quickBtns.forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        
        const rNominal = parseFloat(this.getAttribute('data-r'));
        currentR25 = rNominal;
        
        const tempInput = document.getElementById('input-temp');
        const slider = document.getElementById('temp-slider');
        const resInput = document.getElementById('input-res');
        
        // Actualizar coeficientes Steinhart-Hart para el nuevo valor nominal
        updateCoefficientsForR25(rNominal);
        
        // Si el usuario ingresó una temperatura manualmente, mantenerla
        // y solo recalcular la resistencia correspondiente
        const currentTemp = parseFloat(tempInput.value);
        
        if (!isNaN(currentTemp) && currentTemp >= -40 && currentTemp <= 150) {
            // MANTENER la temperatura ingresada por el usuario
            // Solo recalcular la resistencia para el nuevo tipo de termistor
            if (currentMode === 'steinhart') {
                const A = parseFloat(document.getElementById('sh-a').value);
                const B = parseFloat(document.getElementById('sh-b').value);
                const C = parseFloat(document.getElementById('sh-c').value);
                const R = calcEngine.tempToRes(currentTemp, A, B, C);
                resInput.value = (R / 1000).toFixed(3);
            } else {
                const tableName = document.getElementById('lut-table-select').value;
                if (tableName) {
                    getTable(tableName, (table) => {
                        if (table) {
                            const result = calcEngine.interpolate(currentTemp, table.data, 'T_to_R');
                            if (!result.error) {
                                resInput.value = (result.value / 1000).toFixed(3);
                            }
                        }
                    });
                }
            }
            
            console.log(`✅ Temperatura fija: ${currentTemp}°C → ${rNominal/1000}K = ${(resInput.value)} kΩ`);
        } else {
            // Si no hay temperatura válida, usar 25°C por defecto
            tempInput.value = '25.0';
            slider.value = 25;
            resInput.value = (rNominal / 1000).toFixed(3);
        }
        
        hideAlert();
    });
});


    // Slider
    const slider = document.getElementById('temp-slider');
    const tempInput = document.getElementById('input-temp');
    
    if (slider) {
        slider.addEventListener('input', function() {
            const val = parseFloat(this.value);
            if (!isNaN(val) && tempInput) {
                tempInput.value = val.toFixed(1);
                calculateFromTemp();
            }
        });
    }

    // Input temperatura
    if (tempInput) {
        tempInput.addEventListener('input', function() {
            const val = parseFloat(this.value);
            if (!isNaN(val) && slider) {
                if (val >= -40 && val <= 150) {
                    slider.value = val;
                }
                calculateFromTemp();
            }
        });
    }

    // Input resistencia
    const resInput = document.getElementById('input-res');
    if (resInput) {
        resInput.addEventListener('input', function() {
            calculateFromRes();
        });
    }

    // Botón limpiar
    const clearBtn = document.getElementById('btn-clear');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (tempInput) tempInput.value = '25.0';
            if (slider) slider.value = 25;
            if (resInput) resInput.value = (currentR25 / 1000).toFixed(3);
            hideAlert();
        });
    }

   // Selector de modo
const modeBtns = document.querySelectorAll('.mode-btn');
modeBtns.forEach(btn => {
    btn.addEventListener('click', function() {
        // Remover active de todos los botones
        modeBtns.forEach(b => b.classList.remove('active'));
        
        // Ocultar todos los paneles
        document.querySelectorAll('.calc-panel').forEach(p => {
            p.classList.remove('active');
            p.style.display = 'none';
        });
        
        // Activar botón actual
        this.classList.add('active');
        
        // Obtener modo
        const mode = this.getAttribute('data-mode');
        currentMode = mode;
        
        // Mostrar panel correspondiente
        const panelId = mode + '-panel';
        const panel = document.getElementById(panelId);
        if (panel) {
            panel.classList.add('active');
            panel.style.display = 'block';
        }
        
        console.log(`🔄 Modo cambiado a: ${mode}`);
        
        // Cargar tablas si es modo interpolación
        if (currentMode === 'interpolation') {
            loadTablesToSelect().then(() => {
                // Recalcular con el valor actual de temperatura
                const currentTemp = parseFloat(document.getElementById('input-temp').value);
                if (!isNaN(currentTemp)) {
                    calculateFromTemp();
                }
            });
        } else {
            // Modo Steinhart-Hart - recalcular
            const currentTemp = parseFloat(document.getElementById('input-temp').value);
            if (!isNaN(currentTemp)) {
                calculateFromTemp();
            }
        }
    });
});
}

function updateCoefficientsForR25(R25) {
    const T1 = 0, T2 = 25, T3 = 50;
    const Beta = 3950;
    const T25K = 298.15;
    
    const R1 = R25 * Math.exp(Beta * (1/(T1+273.15) - 1/T25K));
    const R2 = R25;
    const R3 = R25 * Math.exp(Beta * (1/(T3+273.15) - 1/T25K));
    
    const coeffs = calcEngine.calculateCoefficients(T1, R1, T2, R2, T3, R3);
    
    const inputA = document.getElementById('sh-a');
    const inputB = document.getElementById('sh-b');
    const inputC = document.getElementById('sh-c');
    
    if (inputA) inputA.value = coeffs.A.toExponential(6);
    if (inputB) inputB.value = coeffs.B.toExponential(6);
    if (inputC) inputC.value = coeffs.C.toExponential(6);
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
        if (!tableName) {
            showAlert('Seleccione una tabla', 'error');
            return;
        }
        
        getTable(tableName, (table) => {
            if (!table) {
                showAlert('Tabla no encontrada', 'error');
                return;
            }
            const result = calcEngine.interpolate(tC, table.data, 'T_to_R');
            if (result.error) {
                showAlert(result.error, 'error');
            } else {
                document.getElementById('input-res').value = (result.value / 1000).toFixed(3);
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
        
        const slider = document.getElementById('temp-slider');
        if (slider && tC >= -40 && tC <= 150) {
            slider.value = tC;
        }
    } else {
        const tableName = document.getElementById('lut-table-select').value;
        if (!tableName) {
            showAlert('Seleccione una tabla', 'error');
            return;
        }
        
        getTable(tableName, (table) => {
            if (!table) {
                showAlert('Tabla no encontrada', 'error');
                return;
            }
            const result = calcEngine.interpolate(R, table.data, 'R_to_T');
            if (result.error) {
                showAlert(result.error, 'error');
            } else {
                document.getElementById('input-temp').value = result.value.toFixed(1);
                const slider = document.getElementById('temp-slider');
                if (slider && result.value >= -40 && result.value <= 150) {
                    slider.value = result.value;
                }
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
// 7. TABLAS
// ==========================================
function loadTablesToSelect() {
    return new Promise((resolve) => {
        if (!db) {
            resolve();
            return;
        }
        
        const select = document.getElementById('lut-table-select');
        if (!select) {
            resolve();
            return;
        }
        
        const tx = db.transaction(['tables'], 'readonly');
        const store = tx.objectStore('tables');
        const request = store.getAll();
        
        request.onsuccess = () => {
            select.innerHTML = '<option value="">-- Seleccione una tabla --</option>';
            
            const tables = request.result;
            tables.forEach(table => {
                const option = document.createElement('option');
                option.value = table.name;
                option.textContent = table.name;
                select.appendChild(option);
            });
            
            if (tables.length > 0) {
                select.value = tables[0].name;
            }
            
            console.log(`📊 ${tables.length} tablas cargadas`);
            resolve();
        };
        
        request.onerror = () => {
            console.error('Error al cargar tablas');
            resolve();
        };
    });
}

function getTable(name, callback) {
    if (!db || !name) {
        callback(null);
        return;
    }
    
    const tx = db.transaction(['tables'], 'readonly');
    const store = tx.objectStore('tables');
    const request = store.get(name);
    
    request.onsuccess = () => callback(request.result);
    request.onerror = () => callback(null);
}

function setupTables() {
    const fileInput = document.getElementById('csv-upload');
    if (!fileInput) return;
    
    fileInput.addEventListener('change', (e) => {
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
                const store = tx.objectStore('tables');
                store.put({ name: file.name.replace('.csv', ''), data });
                
                tx.oncomplete = () => {
                    alert('✅ Tabla importada correctamente');
                    renderTables();
                    loadTablesToSelect();
                };
            }
        };
        reader.readAsText(file);
    });
}

function renderTables() {
    if (!db) return;
    
    const tx = db.transaction(['tables'], 'readonly');
    const store = tx.objectStore('tables');
    const request = store.getAll();
    
    request.onsuccess = () => {
        const container = document.getElementById('tables-list');
        if (!container) return;
        
        container.innerHTML = '';
        const tables = request.result;
        
        tables.forEach(table => {
            const div = document.createElement('div');
            div.className = 'table-item';
            div.innerHTML = `
                <div class="table-info">
                    <h3>${table.name}</h3>
                    <p>Tabla completa -40°C a 150°C</p>
                </div>
                <button class="table-btn">›</button>
            `;
            container.appendChild(div);
        });
    };
}

// ==========================================
// 8. CLIENTES
// ==========================================
let currentEditingClientId = null;

function setupClients() {
    const newClientBtn = document.getElementById('new-client-btn');
    if (newClientBtn) {
        newClientBtn.addEventListener('click', () => {
            currentEditingClientId = null;
            clearClientForm();
        });
    }

    const saveBtn = document.getElementById('btn-save');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveClient);
    }
    
    const deleteBtn = document.getElementById('btn-delete');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', deleteCurrentClient);
    }

    const toggleBtns = document.querySelectorAll('.toggle-btn');
    toggleBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            toggleBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
        });
    });
}

function clearClientForm() {
    const fields = [
        'client-name', 'client-phone', 'client-email',
        'equipment-name', 'client-note'
    ];
    fields.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    
    const defaults = {
        'therm-int-1': '10.0', 'therm-int-1-temp': '25.0',
        'therm-int-2': '15.0', 'therm-int-2-temp': '20.0',
        'therm-ext-1': '5.0', 'therm-ext-1-temp': '30.0',
        'therm-ext-2': '10.0', 'therm-ext-2-temp': '28.0'
    };
    
    Object.keys(defaults).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = defaults[id];
    });
}

function saveClient() {
    const name = (document.getElementById('client-name').value || '').trim();
    const phone = (document.getElementById('client-phone').value || '').trim();
    const email = (document.getElementById('client-email').value || '').trim();
    const equipment = (document.getElementById('equipment-name').value || '').trim();
    const note = (document.getElementById('client-note').value || '').trim();
    
    const activeToggle = document.querySelector('.toggle-btn.active');
    const equipmentType = activeToggle ? activeToggle.getAttribute('data-type') : 'inverter';

    if (!name || !phone) {
        alert('️ Nombre y Teléfono son obligatorios');
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
        updatedAt: new Date().toISOString()
    };

    if (currentEditingClientId) {
        clientData.id = currentEditingClientId;
    } else {
        clientData.createdAt = new Date().toISOString();
    }

    const tx = db.transaction(['clients'], 'readwrite');
    tx.objectStore('clients').put(clientData);
    tx.oncomplete = () => {
        alert('✅ Cliente guardado correctamente');
        clearClientForm();
        currentEditingClientId = null;
    };
    tx.onerror = () => alert('❌ Error al guardar');
}

function deleteCurrentClient() {
    if (!currentEditingClientId) {
        alert('ℹ️ No hay cliente seleccionado');
        return;
    }
    
    if (confirm('⚠️ ¿Está seguro de eliminar?')) {
        const tx = db.transaction(['clients'], 'readwrite');
        tx.objectStore('clients').delete(currentEditingClientId);
        tx.oncomplete = () => {
            alert('✅ Cliente eliminado');
            clearClientForm();
            currentEditingClientId = null;
        };
    }
}

// ==========================================
// 9. BUSCADOR
// ==========================================
function setupSearch() {
    const searchInput = document.getElementById('global-search');
    if (!searchInput) return;
    
    searchInput.addEventListener('input', function() {
        const query = this.value.toLowerCase().trim();
        const resultsContainer = document.getElementById('search-results');
        
        if (!resultsContainer) return;
        
        resultsContainer.innerHTML = '';
        
        if (query.length < 2) {
            resultsContainer.innerHTML = '<p class="empty-state">Escribe al menos 2 caracteres</p>';
            return;
        }

        const tx = db.transaction(['clients'], 'readonly');
        const store = tx.objectStore('clients');
        const request = store.getAll();
        
        request.onsuccess = () => {
            const matches = request.result.filter(c => {
                return (c.name && c.name.toLowerCase().includes(query)) || 
                       (c.phone && c.phone.includes(query)) ||
                       (c.email && c.email.toLowerCase().includes(query));
            });

            if (matches.length === 0) {
                resultsContainer.innerHTML = '<p class="empty-state">No se encontraron resultados</p>';
                return;
            }

            matches.forEach(c => {
                const div = document.createElement('div');
                div.className = 'result-item';
                div.innerHTML = `
                    <span class="result-icon"></span>
                    <div class="result-info">
                        <strong>${c.name}</strong>
                        <small>📞 ${c.phone} • ✉️ ${c.email || 'Sin email'}</small>
                    </div>
                `;
                div.addEventListener('click', () => loadClientToForm(c));
                resultsContainer.appendChild(div);
            });
        };
    });
}

function loadClientToForm(client) {
    currentEditingClientId = client.id;
    
    const fields = {
        'client-name': client.name,
        'client-phone': client.phone,
        'client-email': client.email || '',
        'equipment-name': client.equipment || '',
        'client-note': client.note || ''
    };
    
    Object.keys(fields).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = fields[id];
    });
    
    if (client.equipmentType) {
        document.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-type') === client.equipmentType) {
                btn.classList.add('active');
            }
        });
    }
    
    if (client.thermistors) {
        const thermFields = {
            'therm-int-1': client.thermistors.int1?.r,
            'therm-int-1-temp': client.thermistors.int1?.t,
            'therm-int-2': client.thermistors.int2?.r,
            'therm-int-2-temp': client.thermistors.int2?.t,
            'therm-ext-1': client.thermistors.ext1?.r,
            'therm-ext-1-temp': client.thermistors.ext1?.t,
            'therm-ext-2': client.thermistors.ext2?.r,
            'therm-ext-2-temp': client.thermistors.ext2?.t
        };
        
        Object.keys(thermFields).forEach(id => {
            const el = document.getElementById(id);
            if (el && thermFields[id]) el.value = thermFields[id];
        });
    }

    const clientesBtn = document.querySelector('[data-view="view-clientes"]');
    if (clientesBtn) clientesBtn.click();
    
    const searchInput = document.getElementById('global-search');
    if (searchInput) searchInput.value = '';
}

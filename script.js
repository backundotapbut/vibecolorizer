(function () {
    'use strict';
    const ADDON_NAME = 'VibeColorizer';

    // ─── Логирование ──────────────────────────────────────────────────────────
    function log(...args) {
        console.debug(`[${ADDON_NAME}]`, ...args);
    }
    function warn(...args) {
        console.warn(`[${ADDON_NAME}]`, ...args);
    }

    let DEBUG = false;
    function debugLog(...args) {
        if (DEBUG) console.log(`%c[${ADDON_NAME} DEBUG]`, 'color: #00bfff; font-weight: bold;', ...args);
    }
    function debugGroup(label, fn) {
        if (DEBUG) {
            console.group(`%c[${ADDON_NAME} DEBUG] ${label}`, 'color: #00bfff;');
            fn();
            console.groupEnd();
        }
    }

    // ─── Настройки ──────────────────────────────────────────────────────────
    const DEFAULTS = {
        enabled: true,
        intensity: 0.85,
        saturation: 1.0,
        brightness: 1.3,
        adaptiveBrightness: true,
        preload: true,
        specialNeutralHandling: true,
        saturationPreference: 0.7,
        useFilterOnPause: true,
        debug: false,
        useAlternativeMethod: false,
        allowExclusion: true
    };

    let settings = { ...DEFAULTS };
    let isReady = false;
    let isPaused = false;
    let lastTrackId = null;
    let currentTargetColor = null;
    let lastWaveColor = null;

    const coverCache = new Map();
    const MAX_CACHE_SIZE = 150;
    let preloadId = 0;
    let activePreloads = 0;
    const MAX_PRELOADS = 2;

    // ─── Хранилище исключённых треков ───────────────────────────────────────
    let excludedTracks = new Set();

    function loadExclusions() {
        try {
            const data = localStorage.getItem(ADDON_NAME + '_excluded');
            if (data) {
                const arr = JSON.parse(data);
                if (Array.isArray(arr)) {
                    excludedTracks = new Set(arr.map(String));
                    debugLog('Загружены исключения:', Array.from(excludedTracks));
                }
            }
        } catch (e) {
            warn('Ошибка загрузки исключений:', e);
        }
    }

    function saveExclusions() {
        try {
            const arr = Array.from(excludedTracks);
            localStorage.setItem(ADDON_NAME + '_excluded', JSON.stringify(arr));
        } catch (e) {
            warn('Ошибка сохранения исключений:', e);
        }
    }

    function isExcluded(trackId) {
        return excludedTracks.has(String(trackId));
    }

    function toggleExclusion(trackId) {
        const id = String(trackId);
        if (excludedTracks.has(id)) {
            excludedTracks.delete(id);
        } else {
            excludedTracks.add(id);
        }
        saveExclusions();
        debugLog('Исключения обновлены:', Array.from(excludedTracks));
        if (isReady) {
            const track = window.pulsesyncApi?.getCurrentTrack();
            if (track && String(track.id) === id) {
                reapplyFilter();
            }
        }
    }

    // ─── Анимационные переменные ──────────────────────────────────────────
    const animDuration = 400;
    const animState = {
        current: { hue: 0, saturate: 1, brightness: 1 },
        target: { hue: 0, saturate: 1, brightness: 1 },
        start: { hue: 0, saturate: 1, brightness: 1 },
        startTime: 0,
        active: false,
        frameId: null
    };
    let lastAppliedFilterString = '';
    let isFilterCleared = true;

    let reapplyTimer = null;
    let playStateDebounceTimer = null;

    // ─── Утилиты для настроек ──────────────────────────────────────────────
    function unwrap(val, fallback) {
        if (val && typeof val === 'object' && 'value' in val) return val.value;
        if (val && typeof val === 'object' && 'default' in val) return val.default;
        return val !== undefined ? val : fallback;
    }

    function applySettings(newS) {
        const oldUseAlternative = settings.useAlternativeMethod;
        const oldSaturationPref = settings.saturationPreference;

        settings.enabled = unwrap(newS.enabled, DEFAULTS.enabled);
        settings.intensity = unwrap(newS.intensity, DEFAULTS.intensity);
        settings.saturation = unwrap(newS.saturation, DEFAULTS.saturation);
        settings.brightness = unwrap(newS.brightness, DEFAULTS.brightness);
        settings.adaptiveBrightness = unwrap(newS.adaptiveBrightness, DEFAULTS.adaptiveBrightness);
        settings.preload = unwrap(newS.preload, DEFAULTS.preload);
        settings.specialNeutralHandling = unwrap(newS.specialNeutralHandling, DEFAULTS.specialNeutralHandling);
        settings.saturationPreference = unwrap(newS.saturationPreference, DEFAULTS.saturationPreference);
        settings.useFilterOnPause = unwrap(newS.useFilterOnPause, DEFAULTS.useFilterOnPause);
        settings.useAlternativeMethod = unwrap(newS.useAlternativeMethod, DEFAULTS.useAlternativeMethod);
        settings.allowExclusion = unwrap(newS.allowExclusion, DEFAULTS.allowExclusion);

        const newDebug = unwrap(newS.debug, DEFAULTS.debug);
        if (newDebug !== DEBUG) {
            DEBUG = newDebug;
            debugLog('Режим отладки', DEBUG ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЁН');
        }

        if (oldUseAlternative !== settings.useAlternativeMethod || oldSaturationPref !== settings.saturationPreference) {
            coverCache.clear();
            debugLog('Кеш обложек очищен из-за изменения параметров извлечения цвета');
            lastTrackId = null;
        }
    }

    function loadSettings() {
        try {
            const store = window.pulsesyncApi?.getSettings(ADDON_NAME);
            if (store) {
                const s = store.getCurrent() || {};
                applySettings(s);
                store.onChange((newS) => {
                    applySettings(newS);
                    if (isReady) {
                        const track = window.pulsesyncApi?.getCurrentTrack();
                        if (track) processTrack(track, true);
                        else reapplyFilter();
                    }
                });
            }
        } catch (e) {
            log('Ошибка загрузки настроек:', e);
        }
    }

    // ─── Кеш ────────────────────────────────────────────────────────────────
    function setCache(key, value) {
        if (coverCache.size >= MAX_CACHE_SIZE) {
            const firstKey = coverCache.keys().next().value;
            coverCache.delete(firstKey);
        }
        coverCache.set(key, value);
    }

    // ─── Цветовые утилиты ──────────────────────────────────────────────────
    function hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;
        if (max === min) {
            h = s = 0;
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h *= 60;
        }
        return { h, s, l };
    }

    function hslToRgb(h, s, l) {
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = l - c / 2;
        let r, g, b;
        if (h < 60) { r = c; g = x; b = 0; }
        else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; }
        else { r = c; g = 0; b = x; }
        return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
    }

    // ─── Вспомогательная функция для получения данных изображения ────────
    function getImageData(img) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const size = 100;
        canvas.width = size;
        canvas.height = size;
        ctx.drawImage(img, 0, 0, size, size);
        return ctx.getImageData(0, 0, size, size).data;
    }

    // ─── Стандартный метод извлечения цвета ──────────────────────────────
    function extractDominantColorDefault(img) {
        const data = getImageData(img);
        if (!data) return null;

        const pref = settings.saturationPreference || 0.7;
        const pixels = [];
        const step = 2;
        const satThreshold = 0.05;

        for (let i = 0; i < data.length; i += step * 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const { s: sat, l: light } = rgbToHsl(r, g, b);
            if (light < 0.03 || light > 0.97 || sat < satThreshold) continue;
            pixels.push({ r, g, b, sat, light });
        }

        if (pixels.length === 0) {
            let r = 0, g = 0, b = 0, count = 0;
            for (let i = 0; i < data.length; i += 16 * 4) {
                r += data[i];
                g += data[i + 1];
                b += data[i + 2];
                count++;
            }
            return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
        }

        pixels.sort((a, b) => b.sat - a.sat);
        const topPercent = 0.05 + pref * 0.75;
        const topCount = Math.max(1, Math.floor(pixels.length * topPercent));
        const topPixels = pixels.slice(0, topCount);

        let rSum = 0, gSum = 0, bSum = 0;
        for (const p of topPixels) {
            rSum += p.r;
            gSum += p.g;
            bSum += p.b;
        }
        let color = {
            r: Math.round(rSum / topPixels.length),
            g: Math.round(gSum / topPixels.length),
            b: Math.round(bSum / topPixels.length)
        };

        const hsl = rgbToHsl(color.r, color.g, color.b);
        if (hsl.l < 0.15 && hsl.s > 0.1) {
            const newLight = Math.min(hsl.l * 1.8, 0.5);
            const rgb = hslToRgb(hsl.h, hsl.s, newLight);
            color = { r: rgb.r, g: rgb.g, b: rgb.b };
            debugLog('Коррекция яркости: был', { r: color.r, g: color.g, b: color.b }, 'стал', color);
        }

        return color;
    }

    // ─── Альтернативный метод извлечения цвета ────────────────────────────
    function extractDominantColorAlternative(img) {
        const data = getImageData(img);
        if (!data) return null;

        const balance = settings.saturationPreference || 0.7;
        const levels = 16;
        const quant = 256 / levels;
        const histogram = new Map();
        let totalPixels = 0;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const { l } = rgbToHsl(r, g, b);
            if (l < 0.03 || l > 0.97) continue;
            const key = `${Math.floor(r/quant)},${Math.floor(g/quant)},${Math.floor(b/quant)}`;
            histogram.set(key, (histogram.get(key) || 0) + 1);
            totalPixels++;
        }

        if (totalPixels === 0) {
            let r = 0, g = 0, b = 0, count = 0;
            for (let i = 0; i < data.length; i += 16 * 4) {
                r += data[i];
                g += data[i + 1];
                b += data[i + 2];
                count++;
            }
            return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
        }

        let bestKey = null;
        let bestScore = -Infinity;

        for (const [key, count] of histogram) {
            const freq = count / totalPixels;
            const [rq, gq, bq] = key.split(',').map(Number);
            const r = Math.round((rq + 0.5) * quant);
            const g = Math.round((gq + 0.5) * quant);
            const b = Math.round((bq + 0.5) * quant);
            const hsl = rgbToHsl(r, g, b);
            const sat = hsl.s;
            const score = freq * (1 - balance) + sat * balance;
            if (score > bestScore) {
                bestScore = score;
                bestKey = key;
            }
        }

        if (!bestKey) return null;
        const [rq, gq, bq] = bestKey.split(',').map(Number);
        return {
            r: Math.round((rq + 0.5) * quant),
            g: Math.round((gq + 0.5) * quant),
            b: Math.round((bq + 0.5) * quant)
        };
    }

    function extractDominantColorFromImage(img) {
        debugLog(settings.useAlternativeMethod ? 'Используем альтернативный метод' : 'Используем стандартный метод');
        return settings.useAlternativeMethod
            ? extractDominantColorAlternative(img)
            : extractDominantColorDefault(img);
    }

    // ─── Получение корневого элемента и цвета волны из CSS ──────────────
    function getRootElement() {
        return document.querySelector('.CommonLayout_root__WC_W1') ||
               document.querySelector('[class*="CommonLayout_root"]');
    }

    function getCurrentWaveColorFromCSS() {
        try {
            const root = getRootElement();
            if (!root) {
                warn('Корневой элемент не найден');
                return null;
            }
            const colorStr = getComputedStyle(root).getPropertyValue('--vibe-gradient-stop-0').trim();
            debugLog('CSS-переменная --vibe-gradient-stop-0 =', colorStr);
            if (!colorStr) {
                const fallback = { r: 0, g: 191, b: 255 };
                debugLog('⚠️ FALLBACK: цветовая переменная пуста, используем', fallback);
                return fallback;
            }
            let rgb = null;
            const rgbMatch = colorStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
            if (rgbMatch) {
                rgb = { r: parseInt(rgbMatch[1]), g: parseInt(rgbMatch[2]), b: parseInt(rgbMatch[3]) };
            } else {
                rgb = hexToRgb(colorStr);
            }
            if (!rgb) {
                const fallback = { r: 0, g: 191, b: 255 };
                debugLog('⚠️ FALLBACK: не удалось распарсить цвет, используем', fallback);
                return fallback;
            }
            debugLog('Исходный цвет волны (RGB):', rgb);
            return rgb;
        } catch (e) {
            const fallback = { r: 0, g: 191, b: 255 };
            debugLog('⚠️ FALLBACK: исключение при получении цвета волны, используем', fallback);
            return fallback;
        }
    }

    // ─── Адаптивный расчёт фильтра ──────────────────────────────────────────
    function computeFilterValues(targetColor) {
        const defaultValues = { hue: 0, saturate: 1, brightness: 1 };
        if (!targetColor) {
            debugLog('computeFilterValues: targetColor = null, возвращаем default');
            return defaultValues;
        }

        const source = getCurrentWaveColorFromCSS();
        if (!source) {
            debugLog('⚠️ FALLBACK: source color = null, возвращаем default');
            return defaultValues;
        }

        const sourceHsl = rgbToHsl(source.r, source.g, source.b);
        const targetHsl = rgbToHsl(targetColor.r, targetColor.g, targetColor.b);

        let deltaH = targetHsl.h - sourceHsl.h;
        if (deltaH > 180) deltaH -= 360;
        if (deltaH < -180) deltaH += 360;

        const targetSaturation = targetHsl.s;
        const targetLightness = targetHsl.l;

        const isWhite = targetLightness > 0.9;
        const isBlack = targetLightness < 0.1;
        const isNeutral = targetSaturation < 0.1 && !isWhite && !isBlack;

        debugGroup('Расчёт фильтра', () => {
            console.log('Исходный цвет (source):', source, 'HSL:', sourceHsl);
            console.log('Целевой цвет (target):', targetColor, 'HSL:', targetHsl);
            console.log('ΔH (град):', deltaH);
            console.log('Категория:', isWhite ? 'БЕЛЫЙ' : isBlack ? 'ЧЁРНЫЙ' : isNeutral ? 'НЕЙТРАЛЬНЫЙ' : 'ОБЫЧНЫЙ');
        });

        let finalHue = 0;
        let finalBright = settings.brightness;
        let finalSaturate = settings.saturation;

        const absDelta = Math.abs(deltaH);
        let intensity = settings.intensity;
        if (absDelta < 15) {
            intensity *= (absDelta / 15);
        } else if (absDelta < 30) {
            intensity *= 0.5;
        }

        if (settings.adaptiveBrightness) {
            const deltaLightness = (targetLightness - 0.5) * 0.8;
            if (targetLightness > 0.5) {
                finalBright = Math.min(2.0, finalBright + deltaLightness);
            } else {
                const darkFactor = 1 - (targetLightness / 0.5);
                finalSaturate = Math.max(0.1, finalSaturate * (1 - darkFactor * 0.9));
                finalBright = Math.max(0.5, finalBright);
            }
        }

        if (isWhite) {
            if (settings.specialNeutralHandling) {
                finalBright = Math.min(2.0, finalBright * 2.0);
                finalSaturate = Math.min(0.2, settings.saturation * 0.2);
                finalHue = 0;
                debugLog('Белый цвет: обработано специально, яркость=', finalBright, 'насыщенность=', finalSaturate);
            } else {
                debugLog('⚠️ FALLBACK: белый цвет, specialNeutralHandling выключен → возвращаем default');
                return defaultValues;
            }
        } else if (isBlack) {
            if (settings.specialNeutralHandling) {
                finalBright = Math.max(0.4, finalBright * 0.5);
                finalSaturate = 0.1;
                finalHue = 0;
                debugLog('Чёрный цвет: обработано специально, яркость=', finalBright, 'насыщенность=', finalSaturate);
            } else {
                debugLog('⚠️ FALLBACK: чёрный цвет, specialNeutralHandling выключен → возвращаем default');
                return defaultValues;
            }
        } else if (isNeutral) {
            if (settings.specialNeutralHandling) {
                finalBright = Math.min(1.4, Math.max(0.6, finalBright * (0.8 + targetLightness * 0.4)));
                finalSaturate = Math.min(0.15, settings.saturation * 0.15);
                if (absDelta > 5 && absDelta < 45) {
                    finalHue = deltaH * 0.1;
                } else {
                    finalHue = 0;
                }
                debugLog('Нейтральный цвет: обработано специально, яркость=', finalBright, 'насыщенность=', finalSaturate, 'оттенок=', finalHue);
            } else {
                debugLog('⚠️ FALLBACK: нейтральный цвет, specialNeutralHandling выключен → возвращаем default');
                return defaultValues;
            }
        } else {
            finalHue = deltaH * intensity;
            debugLog('Обычный цвет: оттенок=', finalHue, 'интенсивность=', intensity);
        }

        finalHue = Math.min(360, Math.max(-360, finalHue));
        finalBright = Math.min(2.0, Math.max(0.5, finalBright));
        finalSaturate = Math.min(1.5, Math.max(0.1, finalSaturate));

        const result = { hue: finalHue, saturate: finalSaturate, brightness: finalBright };
        debugLog('Итоговые значения фильтра:', result);
        return result;
    }

    // ─── Работа с canvas ──────────────────────────────────────────────────
    function getCanvas() {
        try {
            const root = document.querySelector('[class*="VibePage_root"]');
            if (root) {
                const canvas = root.querySelector('canvas');
                if (canvas) return canvas;
            }
            const anyCanvas = document.querySelector('canvas');
            if (anyCanvas) return anyCanvas;
            const animRoot = document.querySelector('[class*="VibeWidgetAnimation_root"]');
            if (animRoot) {
                const canvas = animRoot.querySelector('canvas');
                if (canvas) return canvas;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    // ─── Применение фильтра ──────────────────────────────────────────────
    function applyFilterValues(values) {
        const canvas = getCanvas();
        if (!canvas) {
            debugLog('applyFilterValues: canvas не найден');
            return;
        }
        const filter = `hue-rotate(${values.hue}deg) saturate(${values.saturate}) brightness(${values.brightness})`;
        canvas.style.filter = filter;
        lastAppliedFilterString = filter;
        isFilterCleared = false;
    }

    function clearFilter() {
        const canvas = getCanvas();
        if (canvas && canvas.style.filter !== 'none') {
            canvas.style.filter = 'none';
            lastAppliedFilterString = 'none';
            isFilterCleared = true;
            debugLog('Фильтр сброшен (clearFilter)');
        }
    }

    function shouldFilterBeCleared() {
        return isPaused && settings.useFilterOnPause;
    }

    // ─── Плавная анимация фильтра ──────────────────────────────────────
    function startAnimation(targetValues) {
        const canvas = getCanvas();
        if (!canvas) return;

        if (shouldFilterBeCleared() || !settings.enabled || !targetValues) {
            clearFilter();
            animState.current = { hue: 0, saturate: 1, brightness: 1 };
            if (animState.frameId) {
                cancelAnimationFrame(animState.frameId);
                animState.frameId = null;
            }
            animState.active = false;
            return;
        }

        if (animState.active) {
            animState.target = { ...targetValues };
            debugLog('Анимация активна, обновлены целевые значения:', targetValues);
            return;
        }

        const current = animState.current;
        if (targetValues.hue === current.hue &&
            targetValues.saturate === current.saturate &&
            targetValues.brightness === current.brightness) {
            if (lastAppliedFilterString === 'none' || isFilterCleared) {
                applyFilterValues(targetValues);
                debugLog('Применён фильтр (повторно):', targetValues);
            }
            return;
        }

        if (animState.frameId) {
            cancelAnimationFrame(animState.frameId);
            animState.frameId = null;
        }

        animState.start = { ...current };
        animState.target = { ...targetValues };
        animState.startTime = performance.now();
        animState.active = true;

        debugLog('Начало анимации: от', animState.start, 'к', animState.target);

        function step(time) {
            if (shouldFilterBeCleared() || !settings.enabled) {
                clearFilter();
                animState.current = { hue: 0, saturate: 1, brightness: 1 };
                if (animState.frameId) {
                    cancelAnimationFrame(animState.frameId);
                    animState.frameId = null;
                }
                animState.active = false;
                return;
            }

            const elapsed = time - animState.startTime;
            const progress = Math.min(1, elapsed / animDuration);
            const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;

            const current = {
                hue: animState.start.hue + (animState.target.hue - animState.start.hue) * eased,
                saturate: animState.start.saturate + (animState.target.saturate - animState.start.saturate) * eased,
                brightness: animState.start.brightness + (animState.target.brightness - animState.start.brightness) * eased
            };

            applyFilterValues(current);

            if (progress >= 1) {
                animState.current = { ...animState.target };
                animState.active = false;
                animState.frameId = null;
                debugLog('Анимация завершена, финальный фильтр:', animState.target);
            } else {
                animState.frameId = requestAnimationFrame(step);
            }
        }

        animState.frameId = requestAnimationFrame(step);
    }

    // ─── Применение цвета с учётом исключений ────────────────────────────
    function applyColorToCanvas(targetColor, trackId) {
        const canvas = getCanvas();
        if (!canvas) {
            debugLog('applyColorToCanvas: canvas не найден');
            return;
        }

        if (trackId && isExcluded(trackId)) {
            debugLog(`Трек ${trackId} исключён, фильтр сброшен`);
            clearFilter();
            animState.current = { hue: 0, saturate: 1, brightness: 1 };
            if (animState.frameId) {
                cancelAnimationFrame(animState.frameId);
                animState.frameId = null;
            }
            animState.active = false;
            return;
        }

        if (shouldFilterBeCleared()) {
            clearFilter();
            animState.current = { hue: 0, saturate: 1, brightness: 1 };
            if (animState.frameId) {
                cancelAnimationFrame(animState.frameId);
                animState.frameId = null;
            }
            animState.active = false;
            return;
        }

        if (!settings.enabled || !targetColor) {
            clearFilter();
            animState.current = { hue: 0, saturate: 1, brightness: 1 };
            if (animState.frameId) {
                cancelAnimationFrame(animState.frameId);
                animState.frameId = null;
            }
            animState.active = false;
            return;
        }

        const currentWave = getCurrentWaveColorFromCSS();
        if (currentWave && currentWave.r === 0 && currentWave.g === 0 && currentWave.b === 0) {
            debugLog('applyColorToCanvas: цвет волны чёрный, откладываем применение');
            requestAnimationFrame(() => applyColorToCanvas(targetColor, trackId));
            return;
        }

        const targetValues = computeFilterValues(targetColor);
        debugLog('applyColorToCanvas: целевой цвет (RGB):', targetColor, '→ фильтр:', targetValues);
        startAnimation(targetValues);
    }

    // ─── Переприменение с дебаунсом ──────────────────────────────────────
    function reapplyFilter() {
        if (!isReady) return;
        if (isFilterCleared && shouldFilterBeCleared()) return;
        if (reapplyTimer) {
            clearTimeout(reapplyTimer);
            reapplyTimer = null;
        }
        reapplyTimer = setTimeout(() => {
            reapplyTimer = null;
            try {
                const track = window.pulsesyncApi?.getCurrentTrack();
                if (track && currentTargetColor) {
                    applyColorToCanvas(currentTargetColor, track.id);
                    log('Фильтр переприменён (reapplyFilter)');
                } else if (track) {
                    processTrack(track, true);
                } else {
                    applyColorToCanvas(null);
                }
            } catch (e) {}
        }, 50);
    }

    // ─── Кеширование обложек ──────────────────────────────────────────────
    function getCoverUrl(track) {
        if (!track || !track.coverUri) return null;
        let url = track.coverUri.replace(/%%/g, '400x400');
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        return url;
    }

    function loadCoverColor(track, callback) {
        try {
            if (!track) { callback(null); return; }
            const url = getCoverUrl(track);
            if (!url) { callback(null); return; }
            if (coverCache.has(url)) {
                callback(coverCache.get(url));
                return;
            }
            if (activePreloads >= MAX_PRELOADS) {
                debugLog(`loadCoverColor: превышен лимит параллельных загрузок (${MAX_PRELOADS}), пропускаем`);
                callback(null);
                return;
            }
            activePreloads++;
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.referrerPolicy = 'no-referrer';
            const id = ++preloadId;
            const trackId = track.id;

            img.onload = () => {
                activePreloads--;
                if (id !== preloadId) return;
                const currentTrack = window.pulsesyncApi?.getCurrentTrack();
                if (!currentTrack || String(currentTrack.id) !== String(trackId)) {
                    debugLog(`loadCoverColor: трек сменился (был ${trackId}, сейчас ${currentTrack?.id}), игнорируем`);
                    callback(null);
                    return;
                }
                try {
                    const color = extractDominantColorFromImage(img);
                    if (color) {
                        setCache(url, color);
                        debugLog(`loadCoverColor: цвет для трека ${trackId} успешно извлечён`, color);
                        callback(color);
                    } else {
                        callback(null);
                    }
                } catch (e) {
                    callback(null);
                }
            };
            img.onerror = () => {
                activePreloads--;
                if (id !== preloadId) return;
                debugLog(`loadCoverColor: ошибка загрузки обложки для трека ${trackId}`);
                callback(null);
            };
            img.src = url;
        } catch (e) {
            activePreloads--;
            callback(null);
        }
    }

    // ─── Основная логика ──────────────────────────────────────────────────
    let applyTimeout = null;

    function processTrack(track, immediate = false) {
        if (!track) {
            applyColorToCanvas(null);
            return;
        }
        const id = String(track.id);
        if (id === lastTrackId && !immediate) return;
        lastTrackId = id;
        log('Обработка трека:', track.title);
        debugLog(`processTrack: трек ${id} "${track.title}", immediate=${immediate}`);

        if (applyTimeout) {
            clearTimeout(applyTimeout);
            applyTimeout = null;
        }

        const apply = (color) => {
            currentTargetColor = color;
            applyColorToCanvas(color, track.id);
        };

        if (immediate) {
            loadCoverColor(track, apply);
            return;
        }

        applyTimeout = setTimeout(() => {
            debugLog(`processTrack: таймаут 100 мс истёк, загружаем цвет для трека ${id}`);
            loadCoverColor(track, apply);
            applyTimeout = null;
        }, 100);
    }

    function preloadNextTrack() {
        if (!settings.preload) return;
        try {
            const queue = window.pulsesyncApi?.getQueue?.();
            if (!queue || !Array.isArray(queue) || queue.length < 2) return;
            const nextTrack = queue[1];
            if (!nextTrack) return;
            const url = getCoverUrl(nextTrack);
            if (url && !coverCache.has(url)) {
                debugLog(`preloadNextTrack: предзагрузка обложки для следующего трека ${nextTrack.id}`);
                loadCoverColor(nextTrack, () => {});
            }
        } catch (e) {}
    }

    function onTrackChanged() {
        try {
            const track = window.pulsesyncApi?.getCurrentTrack();
            debugLog('onTrackChanged вызван, текущий трек:', track);
            if (!track) {
                applyColorToCanvas(null);
                return;
            }
            processTrack(track);
            preloadNextTrack();
        } catch (e) {}
    }

    // ─── Проверка состояния паузы с debounce ─────────────────────────────
    function checkPlayState() {
        try {
            if (!window.pulsesyncApi) return;
            const playing = window.pulsesyncApi.isPlaying();
            const paused = !playing;
            if (paused === isPaused) return;

            isPaused = paused;
            debugLog(`checkPlayState: состояние паузы мгновенно обновлено на ${isPaused}`);

            if (playStateDebounceTimer) {
                clearTimeout(playStateDebounceTimer);
                playStateDebounceTimer = null;
            }

            playStateDebounceTimer = setTimeout(() => {
                playStateDebounceTimer = null;
                if (!isReady) return;
                if (isPaused) {
                    if (settings.useFilterOnPause) {
                        clearFilter();
                        animState.current = { hue: 0, saturate: 1, brightness: 1 };
                        if (animState.frameId) {
                            cancelAnimationFrame(animState.frameId);
                            animState.frameId = null;
                        }
                        animState.active = false;
                        debugLog('checkPlayState (debounced): пауза, фильтр сброшен');
                    } else {
                        if (currentTargetColor) {
                            const track = window.pulsesyncApi?.getCurrentTrack();
                            applyColorToCanvas(currentTargetColor, track?.id);
                            debugLog('checkPlayState (debounced): пауза, но фильтр сохранён');
                        } else {
                            const track = window.pulsesyncApi?.getCurrentTrack();
                            if (track) processTrack(track, true);
                        }
                    }
                } else {
                    const track = window.pulsesyncApi?.getCurrentTrack();
                    debugLog('checkPlayState (debounced): воспроизведение возобновлено');
                    if (track) {
                        if (currentTargetColor) applyColorToCanvas(currentTargetColor, track.id);
                        else processTrack(track, true);
                    } else {
                        applyColorToCanvas(null);
                    }
                }
            }, 200);
        } catch (e) {}
    }

    // ─── Наблюдение за изменением цвета волны ────────────────────────────
    let waveColorObserver = null;

    function watchWaveColorChanges() {
        const root = getRootElement();
        if (!root) {
            debugLog('watchWaveColorChanges: корневой элемент не найден, повтор через 500 мс');
            setTimeout(watchWaveColorChanges, 500);
            return;
        }

        lastWaveColor = getCurrentWaveColorFromCSS();

        if (waveColorObserver) waveColorObserver.disconnect();
        waveColorObserver = new MutationObserver(() => {
            requestAnimationFrame(() => {
                const newColor = getCurrentWaveColorFromCSS();
                if (newColor) {
                    const changed = !lastWaveColor ||
                        lastWaveColor.r !== newColor.r ||
                        lastWaveColor.g !== newColor.g ||
                        lastWaveColor.b !== newColor.b;
                    if (changed) {
                        debugLog('Цвет волны изменился:', lastWaveColor, '→', newColor);
                        lastWaveColor = newColor;
                        if (currentTargetColor) {
                            const track = window.pulsesyncApi?.getCurrentTrack();
                            applyColorToCanvas(currentTargetColor, track?.id);
                        }
                    }
                }
            });
        });
        waveColorObserver.observe(root, {
            attributes: true,
            attributeFilter: ['style', 'class']
        });
        debugLog('Наблюдение за цветом волны запущено');
    }

    // ===================== КОНТЕКСТНОЕ МЕНЮ И ИСКЛЮЧЕНИЯ =====================

    // ─── Запоминаем последнюю нажатую кнопку, открывающую меню ────────────
    let lastContextMenuButton = null;

    document.addEventListener('mousedown', (event) => {
        const target = event.target.closest('[data-test-id*="CONTEXT_MENU_BUTTON"]');
        if (target) {
            lastContextMenuButton = target;
            debugLog('Запомнена кнопка контекстного меню:', target);
        }
    }, true);

    // ─── Универсальное получение trackId из любого источника ──────────────
    function getTrackIdFromAnySource(sourceElement) {
        if (!sourceElement) return null;

        const trackContainer = sourceElement.closest('[class*="CommonTrack_root"]') ||
                               sourceElement.closest('[class*="Track_root"]') ||
                               sourceElement.closest('[data-track-id]');
        if (trackContainer) {
            const reactFiberProp = Object.keys(trackContainer).find(key => key.startsWith('__reactFiber'));
            if (reactFiberProp) {
                const fiber = trackContainer[reactFiberProp];
                let node = fiber;
                while (node) {
                    const id = node.memoizedProps?.track?.id ||
                               node.memoizedProps?.trackId ||
                               node.memoizedProps?.id;
                    if (id) return String(id);
                    node = node.return;
                }
            }
            const dataId = trackContainer.dataset.trackId ||
                           trackContainer.dataset.intersectionPropertyId?.match(/track_(\d+)/)?.[1];
            if (dataId) return String(dataId);
        }

        const anyTrack = sourceElement.closest('[data-track-id]');
        if (anyTrack) {
            const id = anyTrack.dataset.trackId;
            if (id) return String(id);
        }

        if (sourceElement.closest('[data-test-id="PLAYERBAR_DESKTOP_CONTEXT_MENU_BUTTON"]') ||
            sourceElement.closest('[data-test-id="FULLSCREEN_PLAYER_CONTEXT_MENU_BUTTON"]')) {
            const entity = window.pulsesyncApi?.getCurrentTrack();
            if (entity) return String(entity.id);
        }

        return null;
    }

    // ─── Создание пункта меню (клонирование шаблона) ──────────────────────
    function createExclusionMenuItemFromClone(templateItem, trackId) {
        const newItem = templateItem.cloneNode(true);
        newItem.setAttribute('data-test-id', 'CONTEXT_MENU_EXCLUSION_BUTTON');
        newItem.style.display = '';
        // Запрещаем перенос текста
        newItem.style.whiteSpace = 'nowrap';

        const span = newItem.querySelector('span');
        if (span) {
            const iconSvg = span.querySelector('svg use');
            const labelSpan = span.querySelector('.ContextMenuItem_label__PvJzQ') || span.childNodes[1];
            const excluded = isExcluded(trackId);

            if (iconSvg) {
                iconSvg.setAttribute('xlink:href', `/icons/sprite.svg#${excluded ? 'check' : 'eye-off'}_xxs`);
            }
            if (labelSpan) {
                // Короткий текст, чтобы помещался в одну строку
                labelSpan.textContent = excluded ? 'Вкл. изм. цвет для трека' : 'Откл. изм. цвет для трека';
            }
        }

        newItem.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleExclusion(trackId);
            const newExcluded = isExcluded(trackId);
            const span = newItem.querySelector('span');
            if (span) {
                const iconSvg = span.querySelector('svg use');
                if (iconSvg) {
                    iconSvg.setAttribute('xlink:href', `/icons/sprite.svg#${newExcluded ? 'check' : 'eye-off'}_xxs`);
                }
                const labelSpan = span.querySelector('.ContextMenuItem_label__PvJzQ') || span.childNodes[1];
                if (labelSpan) {
                    labelSpan.textContent = newExcluded ? 'Вкл. изм. цвет для трека' : 'Откл. изм. цвет для трека';
                }
            }
        });

        return newItem;
    }

    // ─── Вставка кнопки в меню ─────────────────────────────────────────────
    function addExclusionButtonToMenu(menuElement, trackId) {
        if (!settings.allowExclusion) return;
        if (menuElement.querySelector('[data-test-id="CONTEXT_MENU_EXCLUSION_BUTTON"]')) return;

        let templateItem = menuElement.querySelector('[data-test-id="CONTEXT_MENU_DOWNLOAD_BUTTON"]');
        if (!templateItem) {
            templateItem = menuElement.querySelector('[role="menuitem"]');
        }
        if (!templateItem) {
            log('Не удалось найти шаблон пункта меню для клонирования');
            return;
        }

        const newItem = createExclusionMenuItemFromClone(templateItem, trackId);
        // Вставляем сразу после "Скачать" – так, чтобы наша кнопка шла следующей
        templateItem.parentElement.insertBefore(newItem, templateItem.nextSibling);
        debugLog('Кнопка исключения добавлена в меню для трека', trackId);
    }

    // ─── Наблюдатель за появлением меню ─────────────────────────────────────
    const menuObserver = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (!(node instanceof HTMLElement)) return;

                let menu = null;
                if (node.matches('[data-test-id="VIBE_CONTEXT_MENU"], [data-test-id="TRACK_CONTEXT_MENU"]')) {
                    menu = node;
                } else {
                    menu = node.querySelector('[data-test-id="VIBE_CONTEXT_MENU"], [data-test-id="TRACK_CONTEXT_MENU"]');
                }
                if (!menu) return;

                if (menu.querySelector('[data-test-id="CONTEXT_MENU_EXCLUSION_BUTTON"]')) return;

                let trackId = null;
                const labelledBy = menu.getAttribute('aria-labelledby');
                if (labelledBy) {
                    const sourceButton = document.getElementById(labelledBy);
                    if (sourceButton) {
                        trackId = getTrackIdFromAnySource(sourceButton);
                    }
                }
                if (!trackId && lastContextMenuButton && document.contains(lastContextMenuButton)) {
                    trackId = getTrackIdFromAnySource(lastContextMenuButton);
                }
                if (!trackId) {
                    const active = document.activeElement;
                    if (active && active.closest('[data-test-id*="CONTEXT_MENU_BUTTON"]')) {
                        trackId = getTrackIdFromAnySource(active);
                    }
                }
                if (!trackId) {
                    const entity = window.pulsesyncApi?.getCurrentTrack();
                    if (entity) trackId = String(entity.id);
                }

                if (trackId) {
                    addExclusionButtonToMenu(menu, trackId);
                } else {
                    debugLog('Не удалось определить trackId для меню', menu);
                }
            });
        });
    });

    menuObserver.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('contextmenu', (event) => {
        const target = event.target.closest('[data-test-id*="CONTEXT_MENU_BUTTON"]');
        if (target) {
            lastContextMenuButton = target;
            debugLog('contextmenu: запомнена кнопка', target);
        }
    }, true);

    // ─── Инициализация ──────────────────────────────────────────────────────
    function init() {
        log('Инициализация...');
        loadExclusions();
        loadSettings();

        const existingCanvas = getCanvas();
        if (existingCanvas) {
            existingCanvas.style.willChange = 'filter';
            existingCanvas.style.overflow = 'hidden';
        }

        const findAndInit = () => {
            const canvas = getCanvas();
            if (canvas) {
                canvas.style.willChange = 'filter';
                canvas.style.overflow = 'hidden';
                if (!isReady) {
                    isReady = true;
                    debugLog('Canvas найден, инициализация завершена');
                    watchWaveColorChanges();
                    reapplyFilter();
                    startTracking();
                }
                return true;
            }
            return false;
        };

        if (findAndInit()) {
            log('Canvas найден сразу');
        } else {
            warn('Canvas не найден, ждём...');
            const observer = new MutationObserver(() => {
                if (findAndInit()) observer.disconnect();
            });
            observer.observe(document.body, { childList: true, subtree: true });

            setTimeout(() => {
                if (!isReady && !findAndInit()) {
                    warn('Canvas не найден после таймаута. Возможно, вы не на странице "Моя волна".');
                }
            }, 5000);
        }

        // ─── Наблюдатель за перестроением canvas внутри VibePage_root ──────
        let canvasObserver = null;
        const root = document.querySelector('[class*="VibePage_root"]');
        if (root) {
            canvasObserver = new MutationObserver(() => {
                if (getCanvas()) reapplyFilter();
            });
            canvasObserver.observe(root, { childList: true, subtree: true });
        } else {
            const rootObserver = new MutationObserver(() => {
                const r = document.querySelector('[class*="VibePage_root"]');
                if (r) {
                    rootObserver.disconnect();
                    canvasObserver = new MutationObserver(() => {
                        if (getCanvas()) reapplyFilter();
                    });
                    canvasObserver.observe(r, { childList: true, subtree: true });
                }
            });
            rootObserver.observe(document.body, { childList: true, subtree: true });
        }

        // ─── Переприменение при смене URL ──────────────────────────────
        let lastUrl = location.href;
        const urlObserver = new MutationObserver(() => {
            const url = location.href;
            if (url !== lastUrl) {
                lastUrl = url;
                setTimeout(() => {
                    if (document.querySelector('[class*="VibePage_root"]')) {
                        debugLog('Смена URL, переприменяем фильтр');
                        reapplyFilter();
                    }
                }, 800);
            }
        });
        urlObserver.observe(document, { subtree: true, childList: true });

        log('Готово');
    }

    function startTracking() {
        if (!window.pulsesyncApi) {
            warn('pulsesyncApi не доступен');
            return;
        }
        window.pulsesyncApi?._waitForPlayer?.(() => {
            setInterval(() => {
                try {
                    const track = window.pulsesyncApi?.getCurrentTrack();
                    if (track && String(track.id) !== lastTrackId) {
                        debugLog('setInterval: обнаружен новый трек (id изменился)');
                        onTrackChanged();
                    }
                    checkPlayState();
                } catch (e) {}
            }, 100);
        });
    }

    log('СКРИПТ ЗАПУЩЕН');
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

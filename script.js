(function () {
    'use strict';
    const ADDON_NAME = 'VibeColorizer';

    function log(...args) {
        console.log(`[${ADDON_NAME}]`, ...args);
    }
    function warn(...args) {
        console.warn(`[${ADDON_NAME}]`, ...args);
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
        useFilterOnPause: true
    };

    let settings = { ...DEFAULTS };
    let lastTrackId = null;
    let isReady = false;
    let isPaused = false;

    const coverCache = new Map();
    let currentPreloadId = 0;

    // ─── Анимационные переменные ──────────────────────────────────────────
    let currentFilterValues = { hue: 0, saturate: 1, brightness: 1 };
    let targetFilterValues = { hue: 0, saturate: 1, brightness: 1 };
    let animating = false;
    let animFrameId = null;
    let animStartTime = 0;
    const animDuration = 400;
    let animStartValues = { hue: 0, saturate: 1, brightness: 1 };

    // ─── Утилиты для настроек ──────────────────────────────────────────────
    function unwrap(val, fallback) {
        if (val && typeof val === 'object' && 'value' in val) return val.value;
        if (val && typeof val === 'object' && 'default' in val) return val.default;
        return val !== undefined ? val : fallback;
    }

    function loadSettings() {
        try {
            const store = window.pulsesyncApi?.getSettings(ADDON_NAME);
            if (store) {
                const s = store.getCurrent() || {};
                settings.enabled = unwrap(s.enabled, DEFAULTS.enabled);
                settings.intensity = unwrap(s.intensity, DEFAULTS.intensity);
                settings.saturation = unwrap(s.saturation, DEFAULTS.saturation);
                settings.brightness = unwrap(s.brightness, DEFAULTS.brightness);
                settings.adaptiveBrightness = unwrap(s.adaptiveBrightness, DEFAULTS.adaptiveBrightness);
                settings.preload = unwrap(s.preload, DEFAULTS.preload);
                settings.specialNeutralHandling = unwrap(s.specialNeutralHandling, DEFAULTS.specialNeutralHandling);
                settings.saturationPreference = unwrap(s.saturationPreference, DEFAULTS.saturationPreference);
                settings.useFilterOnPause = unwrap(s.useFilterOnPause, DEFAULTS.useFilterOnPause);
                store.onChange((newS) => {
                    try {
                        settings.enabled = unwrap(newS.enabled, DEFAULTS.enabled);
                        settings.intensity = unwrap(newS.intensity, DEFAULTS.intensity);
                        settings.saturation = unwrap(newS.saturation, DEFAULTS.saturation);
                        settings.brightness = unwrap(newS.brightness, DEFAULTS.brightness);
                        settings.adaptiveBrightness = unwrap(newS.adaptiveBrightness, DEFAULTS.adaptiveBrightness);
                        settings.preload = unwrap(newS.preload, DEFAULTS.preload);
                        settings.specialNeutralHandling = unwrap(newS.specialNeutralHandling, DEFAULTS.specialNeutralHandling);
                        settings.saturationPreference = unwrap(newS.saturationPreference, DEFAULTS.saturationPreference);
                        settings.useFilterOnPause = unwrap(newS.useFilterOnPause, DEFAULTS.useFilterOnPause);
                        if (isReady) {
                            const track = window.pulsesyncApi?.getCurrentTrack();
                            if (track) processTrack(track, true);
                            else reapplyFilter();
                        }
                    } catch (e) {}
                });
            }
        } catch (e) {
            log('Ошибка загрузки настроек:', e);
        }
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

    // ─── Улучшенное извлечение доминирующего цвета ──────────────────────
    function extractDominantColorFromImage(img) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const w = img.naturalWidth || 400;
        const h = img.naturalHeight || 400;
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;

        const pref = settings.saturationPreference || 0.7;
        const pixels = [];
        const step = 4;
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
            const avg = { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
            log('Преобладающий цвет обложки (усреднение):', avg);
            return avg;
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
        const dominantColor = {
            r: Math.round(rSum / topPixels.length),
            g: Math.round(gSum / topPixels.length),
            b: Math.round(bSum / topPixels.length)
        };
        log('Преобладающий цвет обложки (RGB):', dominantColor);
        return dominantColor;
    }

    // ─── Получение исходного цвета волны из CSS-переменных ──────────────
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
            if (!colorStr) {
                return { r: 0, g: 191, b: 255 };
            }
            let rgb = null;
            const rgbMatch = colorStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
            if (rgbMatch) {
                rgb = { r: parseInt(rgbMatch[1]), g: parseInt(rgbMatch[2]), b: parseInt(rgbMatch[3]) };
            } else {
                rgb = hexToRgb(colorStr);
            }
            if (!rgb) {
                return { r: 0, g: 191, b: 255 };
            }
            log('Исходный цвет волны из CSS:', rgb);
            return rgb;
        } catch (e) {
            return { r: 0, g: 191, b: 255 };
        }
    }

    // ─── Адаптивный расчёт фильтра ──────────────────────────────────────────
    function computeFilterValues(targetColor) {
        const defaultValues = { hue: 0, saturate: 1, brightness: 1 };
        if (!targetColor) return defaultValues;

        const source = getCurrentWaveColorFromCSS();
        if (!source) return defaultValues;

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

        let finalHue = 0;
        let finalBright = settings.brightness;
        let finalSaturate = settings.saturation;

        const absDelta = Math.abs(deltaH);
        let intensity = settings.intensity;
        if (absDelta < 15) {
            intensity = intensity * (absDelta / 15);
        } else if (absDelta < 30) {
            intensity = intensity * 0.5;
        }

        // ─── Адаптивная яркость и насыщенность ──────────────────────────
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

        // ─── Спецобработка нейтральных обложек ─────────────────────────
        if (isWhite) {
            if (settings.specialNeutralHandling) {
                finalBright = Math.min(2.0, finalBright * 1.4);
                finalSaturate = Math.min(0.3, settings.saturation * 0.3);
                finalHue = 0;
            } else {
                return { hue: 0, saturate: 1, brightness: 1 };
            }
        } else if (isBlack) {
            if (settings.specialNeutralHandling) {
                finalBright = Math.max(0.4, finalBright * 0.5);
                finalSaturate = 0.1;
                finalHue = 0;
            } else {
                return { hue: 0, saturate: 1, brightness: 1 };
            }
        } else if (isNeutral) {
            if (settings.specialNeutralHandling) {
                finalBright = Math.min(1.4, Math.max(0.6, finalBright * (0.8 + targetLightness * 0.4)));
                finalSaturate = Math.min(0.3, settings.saturation * 0.3);
                if (absDelta > 5 && absDelta < 45) {
                    finalHue = deltaH * 0.1;
                } else {
                    finalHue = 0;
                }
            } else {
                return { hue: 0, saturate: 1, brightness: 1 };
            }
        } else {
            finalHue = deltaH * intensity;
        }

        finalHue = Math.min(360, Math.max(-360, finalHue));
        finalBright = Math.min(2.0, Math.max(0.5, finalBright));
        finalSaturate = Math.min(1.5, Math.max(0.1, finalSaturate));

        return { hue: finalHue, saturate: finalSaturate, brightness: finalBright };
    }

    // ─── Поиск canvas ──────────────────────────────────────────────────────
    function findCanvas() {
        const root = document.querySelector('[class*="VibePage_root"]');
        if (root) {
            const canvas = root.querySelector('canvas');
            if (canvas) return canvas;
        }
        const anyCanvas = document.querySelector('canvas');
        if (anyCanvas) {
            return anyCanvas;
        }
        const animRoot = document.querySelector('[class*="VibeWidgetAnimation_root"]');
        if (animRoot) {
            const canvas = animRoot.querySelector('canvas');
            if (canvas) return canvas;
        }
        return null;
    }

    function getCanvas() {
        try {
            const canvas = findCanvas();
            if (!canvas) {
                return null;
            }
            return canvas;
        } catch (e) {
            return null;
        }
    }

    // ─── Применение фильтра ──────────────────────────────────────────────
    function applyFilterValues(values) {
        const canvas = getCanvas();
        if (!canvas) return;
        const filter = `hue-rotate(${values.hue}deg) saturate(${values.saturate}) brightness(${values.brightness})`;
        canvas.style.filter = filter;
        canvas.style.overflow = 'hidden';
    }

    function clearFilter() {
        const canvas = getCanvas();
        if (canvas) {
            canvas.style.filter = 'none';
            canvas.style.overflow = 'hidden';
            log('Фильтр сброшен');
        }
    }

    // ─── Плавная анимация ──────────────────────────────────────────────────
    function animateFilter(targetValues) {
        const canvas = getCanvas();
        if (!canvas) return;

        if (isPaused && settings.useFilterOnPause) {
            clearFilter();
            currentFilterValues = { hue: 0, saturate: 1, brightness: 1 };
            if (animFrameId) {
                cancelAnimationFrame(animFrameId);
                animFrameId = null;
            }
            animating = false;
            return;
        }

        if (!settings.enabled || !targetValues) {
            clearFilter();
            currentFilterValues = { hue: 0, saturate: 1, brightness: 1 };
            if (animFrameId) {
                cancelAnimationFrame(animFrameId);
                animFrameId = null;
            }
            animating = false;
            return;
        }

        if (targetValues.hue === currentFilterValues.hue &&
            targetValues.saturate === currentFilterValues.saturate &&
            targetValues.brightness === currentFilterValues.brightness) {
            return;
        }

        if (animFrameId) {
            cancelAnimationFrame(animFrameId);
            animFrameId = null;
        }

        animStartValues = { ...currentFilterValues };
        targetFilterValues = { ...targetValues };
        animStartTime = performance.now();
        animating = true;

        function step(time) {
            const elapsed = time - animStartTime;
            const progress = Math.min(1, elapsed / animDuration);
            const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;

            const current = {
                hue: animStartValues.hue + (targetFilterValues.hue - animStartValues.hue) * eased,
                saturate: animStartValues.saturate + (targetFilterValues.saturate - animStartValues.saturate) * eased,
                brightness: animStartValues.brightness + (targetFilterValues.brightness - animStartValues.brightness) * eased
            };

            applyFilterValues(current);

            if (progress >= 1) {
                currentFilterValues = { ...targetFilterValues };
                animating = false;
                animFrameId = null;
                return;
            }

            animFrameId = requestAnimationFrame(step);
        }

        animFrameId = requestAnimationFrame(step);
    }

    function applyColorToCanvas(targetColor) {
        const canvas = getCanvas();
        if (!canvas) return;

        if (isPaused && settings.useFilterOnPause) {
            clearFilter();
            currentFilterValues = { hue: 0, saturate: 1, brightness: 1 };
            if (animFrameId) {
                cancelAnimationFrame(animFrameId);
                animFrameId = null;
            }
            animating = false;
            return;
        }

        if (!settings.enabled || !targetColor) {
            clearFilter();
            currentFilterValues = { hue: 0, saturate: 1, brightness: 1 };
            if (animFrameId) {
                cancelAnimationFrame(animFrameId);
                animFrameId = null;
            }
            animating = false;
            return;
        }

        const targetValues = computeFilterValues(targetColor);
        animateFilter(targetValues);
    }

    // ─── Переприменение фильтра ──────────────────────────────────────────
    function reapplyFilter() {
        if (!isReady) return;
        try {
            const track = window.pulsesyncApi?.getCurrentTrack();
            if (track && window._vibeCurrentTargetColor) {
                const color = window._vibeCurrentTargetColor;
                applyColorToCanvas(color);
                log('Фильтр переприменён (reapplyFilter)');
            } else if (track) {
                processTrack(track, true);
            } else {
                applyColorToCanvas(null);
            }
        } catch (e) {}
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
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.referrerPolicy = 'no-referrer';
            const id = ++currentPreloadId;
            img.onload = () => {
                if (id !== currentPreloadId) return;
                try {
                    const color = extractDominantColorFromImage(img);
                    if (color) {
                        coverCache.set(url, color);
                        callback(color);
                    } else {
                        callback(null);
                    }
                } catch (e) {
                    callback(null);
                }
            };
            img.onerror = () => {
                if (id !== currentPreloadId) return;
                callback(null);
            };
            img.src = url;
        } catch (e) {
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

        if (applyTimeout) clearTimeout(applyTimeout);

        if (immediate) {
            loadCoverColor(track, (color) => {
                try {
                    if (color) {
                        window._vibeCurrentTargetColor = color;
                        applyColorToCanvas(color);
                    } else {
                        window._vibeCurrentTargetColor = null;
                        applyColorToCanvas(null);
                    }
                } catch (e) {}
            });
            return;
        }

        applyTimeout = setTimeout(() => {
            try {
                loadCoverColor(track, (color) => {
                    try {
                        if (color) {
                            window._vibeCurrentTargetColor = color;
                            applyColorToCanvas(color);
                        } else {
                            window._vibeCurrentTargetColor = null;
                            applyColorToCanvas(null);
                        }
                    } catch (e) {}
                });
            } catch (e) {}
            applyTimeout = null;
        }, 100);
    }

    // ─── Предзагрузка ──────────────────────────────────────────────────────
    function preloadNextTrack() {
        try {
            if (!settings.preload) return;
            const queue = window.pulsesyncApi?.getQueue?.();
            if (!queue || !Array.isArray(queue) || queue.length < 2) return;
            const nextTrack = queue[1];
            if (!nextTrack) return;
            const url = getCoverUrl(nextTrack);
            if (url && !coverCache.has(url)) {
                loadCoverColor(nextTrack, () => {});
            }
        } catch (e) {}
    }

    // ─── Обновление при смене трека ──────────────────────────────────────
    function onTrackChanged() {
        try {
            const track = window.pulsesyncApi?.getCurrentTrack();
            if (!track) {
                applyColorToCanvas(null);
                return;
            }
            processTrack(track);
            preloadNextTrack();
        } catch (e) {}
    }

    // ─── Проверка паузы ──────────────────────────────────────────────────
    function checkPlayState() {
        try {
            if (!window.pulsesyncApi) return;
            const playing = window.pulsesyncApi.isPlaying();
            const paused = !playing;
            if (paused !== isPaused) {
                isPaused = paused;
                if (isReady) {
                    if (paused) {
                        if (settings.useFilterOnPause) {
                            clearFilter();
                        } else {
                            const track = window.pulsesyncApi?.getCurrentTrack();
                            if (track && window._vibeCurrentTargetColor) {
                                applyColorToCanvas(window._vibeCurrentTargetColor);
                            } else if (track) {
                                processTrack(track, true);
                            }
                        }
                    } else {
                        const track = window.pulsesyncApi?.getCurrentTrack();
                        if (track) {
                            processTrack(track, true);
                        } else {
                            applyColorToCanvas(null);
                        }
                    }
                }
            }
        } catch (e) {}
    }

    // ─── Инициализация ──────────────────────────────────────────────────────
    function init() {
        log('Инициализация...');
        loadSettings();

        const canvas = getCanvas();
        if (canvas) {
            isReady = true;
            onTrackChanged();
            startTracking();
        } else {
            warn('Canvas не найден, ждём...');
            const observer = new MutationObserver(() => {
                const c = getCanvas();
                if (c) {
                    observer.disconnect();
                    isReady = true;
                    reapplyFilter();
                    startTracking();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            setTimeout(() => {
                if (!isReady) {
                    const c = getCanvas();
                    if (c) {
                        isReady = true;
                        reapplyFilter();
                        startTracking();
                    } else {
                        warn('Canvas не найден после таймаута. Возможно, вы не на странице "Моя волна".');
                    }
                }
            }, 5000);
        }

        // ─── ПОСТОЯННЫЙ НАБЛЮДАТЕЛЬ ЗА ПОЯВЛЕНИЕМ CANVAS ──────────────
        let canvasObserver = null;
        const root = document.querySelector('[class*="VibePage_root"]');
        if (root) {
            canvasObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeName === 'CANVAS') {
                            log('Canvas пересоздан, переприменяем фильтр');
                            reapplyFilter();
                            return;
                        }
                    }
                }
            });
            canvasObserver.observe(root, { childList: true, subtree: true });
        } else {
            const rootObserver = new MutationObserver(() => {
                const r = document.querySelector('[class*="VibePage_root"]');
                if (r) {
                    rootObserver.disconnect();
                    canvasObserver = new MutationObserver((mutations) => {
                        for (const mutation of mutations) {
                            for (const node of mutation.addedNodes) {
                                if (node.nodeName === 'CANVAS') {
                                    log('Canvas пересоздан (после появления root), переприменяем фильтр');
                                    reapplyFilter();
                                    return;
                                }
                            }
                        }
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
                    try {
                        const rootEl = document.querySelector('[class*="VibePage_root"]');
                        if (rootEl) {
                            log('Обнаружен переход на страницу волны');
                            const c = getCanvas();
                            if (c) {
                                if (!isReady) {
                                    isReady = true;
                                }
                                reapplyFilter();
                            }
                            if (canvasObserver && !canvasObserver._connected) {
                                canvasObserver.observe(rootEl, { childList: true, subtree: true });
                            }
                        }
                    } catch (e) {}
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
            // Основной интервал для смены трека и паузы
            setInterval(() => {
                try {
                    const track = window.pulsesyncApi?.getCurrentTrack();
                    if (track && String(track.id) !== lastTrackId) {
                        onTrackChanged();
                    }
                    checkPlayState();
                } catch (e) {}
            }, 200);

            // ─── ДОПОЛНИТЕЛЬНЫЙ ИНТЕРВАЛ ДЛЯ ПРОВЕРКИ ФИЛЬТРА ──────────
            // Проверяем каждые 300 мс, не сбросился ли фильтр
            setInterval(() => {
                if (!isReady) return;
                const canvas = getCanvas();
                if (!canvas) return;
                const currentFilter = canvas.style.filter || 'none';
                // Если фильтр сброшен (none), но у нас есть сохранённый цвет
                if (currentFilter === 'none' && window._vibeCurrentTargetColor) {
                    log('Фильтр был сброшен (обнаружено в интервале), переприменяем');
                    applyColorToCanvas(window._vibeCurrentTargetColor);
                }
            }, 300);
        });
    }

    log('СКРИПТ ЗАПУЩЕН');
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
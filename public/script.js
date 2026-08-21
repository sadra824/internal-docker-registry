/* ============================================================
   Internal Docker Registry — landing page interactions
   - hero terminal typing animation
   - "simulate a pull" flow walkthrough (cold vs warm)
   - copy-to-clipboard buttons
   All motion respects prefers-reduced-motion.
   ============================================================ */
(function () {
    'use strict';

    var prefersReducedMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
    ).matches;

    /* ---------------- Terminal typing ---------------- */
    var typeTarget = document.getElementById('type-target');

    function typeCommand(el, text, done) {
        var caret = document.createElement('span');
        caret.className = 'caret';
        el.textContent = '';
        el.appendChild(caret);

        var i = 0;
        (function tick() {
            if (i <= text.length) {
                el.textContent = text.slice(0, i);
                el.appendChild(caret);
                i += 1;
                window.setTimeout(tick, 34 + Math.random() * 40);
            } else {
                caret.remove();
                done();
            }
        })();
    }

    if (typeTarget) {
        var command = typeTarget.textContent.trim();

        if (prefersReducedMotion) {
            typeTarget.textContent = command;
        } else {
            // Start typing once the terminal scrolls into view.
            var started = false;
            var startTyping = function () {
                if (started) { return; }
                started = true;
                window.setTimeout(function () {
                    typeCommand(typeTarget, command, function () {});
                }, 350);
            };

            if ('IntersectionObserver' in window) {
                var observer = new IntersectionObserver(function (entries) {
                    entries.forEach(function (entry) {
                        if (entry.isIntersecting) {
                            startTyping();
                            observer.disconnect();
                        }
                    });
                }, { threshold: 0.4 });
                observer.observe(typeTarget);
            } else {
                startTyping();
            }
        }
    }

    /* ---------------- Pull simulation ---------------- */
    var scenario = 'warm'; // default: cache hit
    var segButtons = Array.prototype.slice.call(
        document.querySelectorAll('.seg-btn')
    );
    var branches = Array.prototype.slice.call(
        document.querySelectorAll('[data-branch]')
    );
    var runButton = document.getElementById('sim-run');
    var flowSteps = Array.prototype.slice.call(
        document.querySelectorAll('.flow-step')
    );

    function stepsFor(current) {
        // حالت ساده (بدون شاخه‌ی hit/miss): همه‌ی مراحل پشت‌سرهم
        if (!document.querySelector('[data-branch]')) {
            return flowSteps;
        }

        var selector = current === 'warm'
            ? '[data-step="1"], [data-step="2"], [data-step="3w"]'
            : '[data-step="1"], [data-step="2"], [data-step="3c"], [data-step="4c"], [data-step="5c"]';
        return Array.prototype.slice.call(
            document.querySelectorAll(selector)
        );
    }

    function applyScenario(next) {
        scenario = next;

        segButtons.forEach(function (btn) {
            btn.setAttribute(
                'aria-pressed',
                String(btn.dataset.scenario === next)
            );
        });

        branches.forEach(function (branch) {
            var isCurrent = branch.dataset.branch === next;
            branch.classList.toggle('inactive', !isCurrent);
        });

        resetSteps();
    }

    function resetSteps() {
        flowSteps.forEach(function (step) {
            step.classList.remove('active', 'done');
        });
    }

    segButtons.forEach(function (btn) {
        btn.addEventListener('click', function () {
            applyScenario(btn.dataset.scenario);
        });
    });

    if (runButton) {
        runButton.addEventListener('click', function () {
            var sequence = stepsFor(scenario);
            resetSteps();

            var delay = prefersReducedMotion ? 0 : 750;

            sequence.forEach(function (step, index) {
                window.setTimeout(function () {
                    sequence.forEach(function (s, i) {
                        s.classList.toggle('done', i < index);
                    });
                    step.classList.add('active');
                }, delay * index);
            });

            window.setTimeout(function () {
                sequence.forEach(function (step) {
                    step.classList.remove('active');
                    step.classList.add('done');
                });
            }, delay * sequence.length);
        });
    }

    applyScenario(scenario);

    /* ---------------- Copy buttons ---------------- */
    function flashButton(btn) {
        var label = btn.lastChild;
        btn.classList.add('copied');
        if (label && label.nodeType === Node.TEXT_NODE) {
            label.textContent = ' کپی شد!';
        }
        window.setTimeout(function () {
            btn.classList.remove('copied');
            if (label && label.nodeType === Node.TEXT_NODE) {
                label.textContent = ' کپی';
            }
        }, 1600);
    }

    function legacyCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (err) { /* noop */ }
        document.body.removeChild(ta);
    }

    Array.prototype.forEach.call(
        document.querySelectorAll('.copy-btn'),
        function (btn) {
            btn.addEventListener('click', function () {
                var text = btn.dataset.copy || '';
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(
                        function () { flashButton(btn); },
                        function () { legacyCopy(text); flashButton(btn); }
                    );
                } else {
                    legacyCopy(text);
                    flashButton(btn);
                }
            });
        }
    );
})();

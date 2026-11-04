(function(window, document, mode) {
      try {
        document.documentElement.dataset.seed = '';
        document.documentElement.dataset.seedColorMode = mode;
      } catch (e) {}

      try {
        var prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

        if ('addEventListener' in prefersDark) {
          prefersDark.addEventListener('change', apply);
        } else if ('addListener' in prefersDark) {
          prefersDark.addListener(apply);
        }

        if (prefersDark.matches) {
          document.documentElement.dataset.seedUserColorScheme = 'dark';
        } else {
          document.documentElement.dataset.seedUserColorScheme = 'light';
        }

        function apply() {
          document.documentElement.dataset.seedUserColorScheme = prefersDark.matches ? 'dark' : 'light';
        }
      } catch (e) {}

      try {
        if (typeof window.AndroidFunction !== 'undefined') {
          document.documentElement.dataset.seedPlatform = 'android';
        } else if (typeof window.webkit !== 'undefined' && typeof window.webkit.messageHandlers !== 'undefined') {
          document.documentElement.dataset.seedPlatform = 'ios';
        } else {
          document.documentElement.dataset.seedPlatform = 'ios';
        }
      } catch (e) {}

      var seedAndroidFontScale = 1;
      try {
        if (document.documentElement.dataset.seedPlatform === 'android') {
          var rootSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
          seedAndroidFontScale = rootSize > 0 ? rootSize / 16 : 1;
          document.documentElement.style.setProperty('--seed-static-font-scale', seedAndroidFontScale.toString());
        }
      } catch (e) {}

      try {
        if (false) {
          var platform = document.documentElement.dataset.seedPlatform;

          if (platform === 'ios') {
            document.documentElement.dataset.seedFontScaling = 'enabled';

            function applyIOSFontScaling() {
              try {
                var tempEl = document.createElement('div');
                tempEl.style.cssText = 'position:absolute;visibility:hidden;font-size:16px;font:-apple-system-body;';
                document.body.appendChild(tempEl);
                var size = parseFloat(window.getComputedStyle(tempEl).fontSize);
                document.body.removeChild(tempEl);
                var raw = size > 0 ? (size / 16) * 0.9412 : 1;
                var scale = Math.max(0.8, Math.min(1.35, raw));
                document.documentElement.dataset.seedFontMultiplier = parseFloat(scale.toFixed(2)).toString();
              } catch (e) {}
            }

            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', applyIOSFontScaling);
            } else {
              applyIOSFontScaling();
            }
          } else if (platform === 'android') {
            var applied = Math.max(0.8, Math.min(1.5, seedAndroidFontScale));
            document.documentElement.dataset.seedFontMultiplier = parseFloat(applied.toFixed(2)).toString();
            document.documentElement.dataset.seedFontScaling = 'enabled';
          }
        }
      } catch (e) {}
    })(window, document, 'system');

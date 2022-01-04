(() => {
  const cookieThemeKey = 'theme';
  const themes = {
    dark: 'dark',
    light: 'light'
  }
  const darkModeClass = 'dark-mode';
  
  function setCookie(name,value,days) {
    var expires = "";
    if (days) {
        var date = new Date();
        date.setTime(date.getTime() + (days*24*60*60*1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (value || "")  + expires + "; path=/";
  }
  function getCookie(name) {
    var nameEQ = name + "=";
    var ca = document.cookie.split(';');
    for(var i=0;i < ca.length;i++) {
        var c = ca[i];
        while (c.charAt(0)==' ') c = c.substring(1,c.length);
        if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length);
    }
    return null;
  }
  
  function toggleTheme() {
    let classes = document.body.getAttribute('class');
    if (classes.indexOf(darkModeClass) !== -1) {
      classes = classes.replace(darkModeClass, '');
      setCookie(cookieThemeKey, themes.light);
    } else {
      classes = classes.trim()+' '+darkModeClass;
      setCookie(cookieThemeKey, themes.dark)
    }
    document.body.setAttribute('class', classes);
  }
  
  let switcher = document.querySelectorAll('.switcher');

  let lightThemeSwitcher = document.querySelector('.switcher-sun');
  let darkThemeSwitcher = document.querySelector('.switcher-moon');

  lightThemeSwitcher.addEventListener('mouseover', (ev) => {
    lightThemeSwitcher.setAttribute('class', lightThemeSwitcher.getAttribute('class').replace('fadeout', '').trim()+' fadeout');
    darkThemeSwitcher.setAttribute('class', darkThemeSwitcher.getAttribute('class').replace('fadein', '').trim()+' fadein');
  });

  lightThemeSwitcher.addEventListener('mouseout', (ev) => {
    lightThemeSwitcher.setAttribute('class', lightThemeSwitcher.getAttribute('class').replace('fadeout', '').trim());
    darkThemeSwitcher.setAttribute('class', darkThemeSwitcher.getAttribute('class').replace('fadein', '').trim());
  });

  darkThemeSwitcher.addEventListener('mouseover', (ev) => {
    darkThemeSwitcher.setAttribute('class', darkThemeSwitcher.getAttribute('class').replace('fadeout', '').trim()+' fadeout');
    lightThemeSwitcher.setAttribute('class', lightThemeSwitcher.getAttribute('class').replace('fadein', '').trim()+' fadein');
  });

  darkThemeSwitcher.addEventListener('mouseout', (ev) => {
    darkThemeSwitcher.setAttribute('class', darkThemeSwitcher.getAttribute('class').replace('fadeout', '').trim());
    lightThemeSwitcher.setAttribute('class', lightThemeSwitcher.getAttribute('class').replace('fadein', '').trim());
  });

  switcher.forEach(el => {
    el.addEventListener('click', toggleTheme);
  });

  let searchResults = document.querySelector('.search-results');
  let searchField = document.querySelector('.search-button');
  let searchFieldInput = document.querySelector('.search-button input');
  let searchFieldBackground = document.querySelector('.search-button + .search-background');
  if (searchField) {
    searchField.addEventListener('click', () => searchFieldInput.focus());
    searchFieldInput.addEventListener('focus', ev => {
      let classes = searchField.getAttribute('class');
      if (classes.indexOf('active') === -1) {
        classes += ' active';
        searchField.setAttribute('class', classes);
      }
    });

    const searchTimeout = 400;
    let lastSearchRequest = {
      tms: null,
      job: null
    };

    searchField.addEventListener('input', ev => {
      searchResults.innerHTML = '';
      const searchQuery = ev.target.value;
      clearTimeout(lastSearchRequest.job);
      if (searchQuery === '') {
        return;
      };
      lastSearchRequest.job = setTimeout(() => {
        fetch(`/search?query=${searchQuery}`)
          .then(res => res.json())
          .then(res => {
            res.forEach(player => {
              player.username = player.username.length > 20 ? (player.username.substr(0, 20)+'...') : player.username;
              searchResults.innerHTML += `
                <a href="/u/${player.user_id}" class="search-result-item">
                  <span>${player.username}</span>
                  <span>${Math.trunc(player.elo)}</span>
                </a>
              `;
            });
            if (res.length === 0) {
              searchResults.innerHTML = `
                <div class="search-result-item not-found">
                  Nothing found!
                </div>
              `;
            }
          });
      }, searchTimeout);
      lastSearchRequest.tms = Date.now();
    });

    searchFieldBackground.addEventListener('click', () => {
      searchField.setAttribute('class', searchField.getAttribute('class').replace('active', '').trim());
    });
  }

  function documentKeydown(event) {
    if (event.key === "Enter") {
      let activeItem = document.querySelector('.search-result-item.active');
      if (activeItem) {
        document.location = activeItem.getAttribute('href');
      }
    }
    const changeActiveItem = isDown => {
      if (searchFieldInput === document.activeElement) {
        searchFieldInput.blur();
      }
      let items = document.querySelectorAll('.search-result-item');
      if (!document.querySelector('.search-result-item.active')) {
        items[0].setAttribute('class', items[0].getAttribute('class')+' active');
        return;
      }
      for(let i = 0; i < items.length; i++) {
        if (items[i].getAttribute('class').indexOf('active') !== -1) {
          items[i].setAttribute('class', items[i].getAttribute('class').replace('active', '').trim());
          let nextIndex;
          if (isDown) {
            nextIndex = ((i + 1) > (items.length - 1)) ? 0 : (i + 1);
          } else {
            nextIndex = ((i - 1) < 0) ? (items.length - 1) : (i - 1);
          }
          items[nextIndex].setAttribute('class', items[nextIndex].getAttribute('class')+' active');
          return;
        }
      }
    }
    if (event.keyCode === 40) {
      if (document.querySelector('.search-button.active')) {
        event.preventDefault();
      }
      changeActiveItem(true);
    }
    if (event.keyCode === 38) {
      if (document.querySelector('.search-button.active')) {
        event.preventDefault();
      }
      changeActiveItem(false);
    }
    if (event.key === "Escape") {
      searchField.setAttribute('class', searchField.getAttribute('class').replace('active', '').trim());
      searchFieldInput.blur();
    }
  }

  document.onkeydown = documentKeydown;
})();
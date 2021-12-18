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
    el.removeEventListener('click', toggleTheme);
    el.addEventListener('click', toggleTheme);
  });
})()
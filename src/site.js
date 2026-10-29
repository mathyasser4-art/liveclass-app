// First launch (and LiveClass → Change site…): which platform this teacher uses.
window.lcApp.sites().then(({ sites, current }) => {
    const box = document.getElementById('sites');
    sites.forEach((site) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'site';
        const name = document.createElement('span');
        name.textContent = site.name;
        const host = document.createElement('small');
        host.textContent = new URL(site.url).host + (site.id === current ? ' ✓' : '');
        button.append(name, host);
        button.addEventListener('click', () => window.lcApp.chooseSite(site.id));
        box.appendChild(button);
    });
});

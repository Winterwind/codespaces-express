(function () {
  'use strict';

  const TEAL_BG     = 'rgba(61, 214, 190, 0.28)';
  const TEAL_HOVER  = 'rgba(61, 214, 190, 0.55)';
  const TEAL_BORDER = '#1aab96';

  let charts = [];
  let currentPeriod = 'daily';

  function makeDailyLabels() {
    const labels = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      labels.push((d.getMonth() + 1) + '/' + d.getDate());
    }
    return labels;
  }

  function makeWeeklyLabels() {
    const labels = [];
    const today = new Date();
    for (let w = 7; w >= 0; w--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (w * 7 + 6));
      labels.push((d.getMonth() + 1) + '/' + d.getDate());
    }
    return labels;
  }

  function buildChart(canvas, period) {
    const valueKey = period === 'daily' ? 'dailyValues' : 'weeklyValues';

    const labels = period === 'daily' ? makeDailyLabels() : makeWeeklyLabels();
    const values = JSON.parse(canvas.dataset[valueKey]);

    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: TEAL_BG,
          hoverBackgroundColor: TEAL_HOVER,
          borderColor: TEAL_BORDER,
          borderWidth: 1,
          borderRadius: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (item) {
                const n = item.raw;
                return n + ' contribution' + (n !== 1 ? 's' : '');
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              font: { size: 10 },
              color: '#94a9b5',
              maxTicksLimit: 10,
              maxRotation: 0
            }
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.05)' },
            border: { display: false },
            ticks: {
              font: { size: 10 },
              color: '#94a9b5',
              precision: 0,
              stepSize: 1
            }
          }
        }
      }
    });
  }

  function initCharts(period) {
    charts.forEach(function (c) { c.destroy(); });
    charts = [];

    document.querySelectorAll('.contributor-chart').forEach(function (canvas) {
      charts.push(buildChart(canvas, period));
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    const contribPanel = document.querySelector('[data-tab-panel="project"][data-panel="contributors"]');
    if (!contribPanel) return;

    // If contributors panel is somehow initially active, render right away
    if (contribPanel.classList.contains('active')) {
      initCharts(currentPeriod);
    }

    // Render when the contributors tab is clicked
    const contribTab = document.querySelector('[data-tab-group="project"] [data-tab="contributors"]');
    if (contribTab) {
      contribTab.addEventListener('click', function () {
        // Small delay so the panel is visible before Chart.js measures canvas size
        setTimeout(function () { initCharts(currentPeriod); }, 50);
      });
    }

    // Day / week toggle
    const toggle = document.getElementById('contrib-toggle');
    if (toggle) {
      toggle.addEventListener('click', function (e) {
        const btn = e.target.closest('.contrib-toggle-btn');
        if (!btn) return;
        toggle.querySelectorAll('.contrib-toggle-btn').forEach(function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        currentPeriod = btn.dataset.period;
        initCharts(currentPeriod);
      });
    }
  });
})();

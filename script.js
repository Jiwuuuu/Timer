let timer;
let timeInSeconds = 0;
let isRunning = false;

const timeDisplay = document.getElementById('time-display');
const setTimerBtn = document.getElementById('set-timer-btn');
const startBtn = document.getElementById('start-btn');
const pauseBtn = document.getElementById('pause-btn');
const deductBtn = document.getElementById('deduct-btn');
const clearBtn = document.getElementById('clear-btn');


function formatTime(seconds) {
    const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
}


function updateTimeDisplay() {
    timeDisplay.textContent = formatTime(timeInSeconds);
}


setTimerBtn.addEventListener('click', () => {
    const userTime = prompt("Enter the time in minutes:");
    if (!isNaN(userTime) && userTime !== null) {
        timeInSeconds = parseInt(userTime) * 60;
        updateTimeDisplay();
    }
});


startBtn.addEventListener('click', () => {
    if (!isRunning) {
        isRunning = true;
        timer = setInterval(() => {
            if (timeInSeconds > 0) {
                timeInSeconds--;
                updateTimeDisplay();
            } else {
                clearInterval(timer);
                alert("Time's up!");
                isRunning = false;
            }
        }, 1000);
    }
});


pauseBtn.addEventListener('click', () => {
    if (isRunning) {
        clearInterval(timer);
        isRunning = false;
    }
});


deductBtn.addEventListener('click', () => {
    timeInSeconds = Math.max(timeInSeconds - 300, 0);
    updateTimeDisplay();
});


clearBtn.addEventListener('click', () => {
    clearInterval(timer);
    timeInSeconds = 0;
    updateTimeDisplay();
    isRunning = false;
});

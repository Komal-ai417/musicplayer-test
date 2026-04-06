document.addEventListener('DOMContentLoaded', () => {
    // --- DOM ELEMENTS ---
    const audioPlayer = document.getElementById('audio-player');
    const currentSongDisplay = document.getElementById('current-song-display');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const playPauseIcon = document.getElementById('play-pause-icon');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const shuffleBtn = document.getElementById('shuffle-btn');
    const repeatBtn = document.getElementById('repeat-btn');
    const fileInput = document.getElementById('file-input');
    const playlistUl = document.getElementById('playlist-ul');
    const progressBar = document.querySelector('.progress-bar');
    const progressWrapper = document.querySelector('.progress-bar-wrapper');
    const currentTimeDisplay = document.getElementById('current-time');
    const totalTimeDisplay = document.getElementById('total-time');

    // --- STATE ---
    let playlist = []; // Will now store objects: { name: 'song.mp3', url: 'blob:...' }
    let currentIndex = -1;
    let isShuffle = false;
    let isRepeat = false;

    // --- FUNCTIONS ---

    function loadSong(index) {
        if (index < 0 || index >= playlist.length) return;
        currentIndex = index;
        const song = playlist[currentIndex];
        audioPlayer.src = song.url;
        currentSongDisplay.textContent = song.name;
        renderPlaylist();
    }

    function playSong() {
        audioPlayer.play();
        playPauseIcon.classList.remove('fa-play');
        playPauseIcon.classList.add('fa-pause');
    }

    function pauseSong() {
        audioPlayer.pause();
        playPauseIcon.classList.remove('fa-pause');
        playPauseIcon.classList.add('fa-play');
    }

    function playNext() {
        if (playlist.length === 0) return;
        let newIndex;
        if (isShuffle) {
            do {
                newIndex = Math.floor(Math.random() * playlist.length);
            } while (playlist.length > 1 && newIndex === currentIndex);
        } else {
            newIndex = currentIndex + 1;
            if (newIndex >= playlist.length) {
                if (isRepeat) newIndex = 0;
                else return; // Stop at the end
            }
        }
        loadSong(newIndex);
        playSong();
    }

    function playPrev() {
        if (playlist.length === 0) return;
        let newIndex = isShuffle ? Math.floor(Math.random() * playlist.length) : currentIndex - 1;
        if (newIndex < 0) {
            if (isRepeat) newIndex = playlist.length - 1;
            else return; // Stop at the beginning
        }
        loadSong(newIndex);
        playSong();
    }

    function renderPlaylist() {
        playlistUl.innerHTML = '';
        if (playlist.length === 0) {
            playlistUl.innerHTML = '<li>Add songs to begin.</li>';
            return;
        }
        playlist.forEach((song, index) => {
            const li = document.createElement('li');
            li.textContent = song.name;
            if (index === currentIndex) li.classList.add('playing');
            li.addEventListener('click', () => {
                loadSong(index);
                playSong();
            });
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-btn';
            deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
            deleteBtn.onclick = (e) => { e.stopPropagation(); removeSong(index); };
            li.appendChild(deleteBtn);
            playlistUl.appendChild(li);
        });
    }
    
    function removeSong(indexToRemove) {
        // Revoke the object URL to free up memory
        URL.revokeObjectURL(playlist[indexToRemove].url);
        playlist.splice(indexToRemove, 1);

        if (playlist.length === 0) {
            audioPlayer.src = '';
            currentIndex = -1;
            currentSongDisplay.textContent = 'None';
            pauseSong();
        } else if (currentIndex === indexToRemove) {
            // If the current song was removed, play the next one
            playNext();
        } else if (currentIndex > indexToRemove) {
            // Adjust index if a song before the current one was removed
            currentIndex--;
        }
        renderPlaylist();
    }

    function formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    }

    function updateProgress() {
        const { duration, currentTime } = audioPlayer;
        if (duration) {
            const progressPercent = (currentTime / duration) * 100;
            progressBar.style.width = `${progressPercent}%`;
            currentTimeDisplay.textContent = formatTime(currentTime);
            totalTimeDisplay.textContent = formatTime(duration);
        }
    }

    function setProgress(e) {
        const width = this.clientWidth;
        const clickX = e.offsetX;
        const duration = audioPlayer.duration;
        if (duration) {
            audioPlayer.currentTime = (clickX / width) * duration;
        }
    }

    // --- EVENT LISTENERS ---
    fileInput.addEventListener('change', (e) => {
        const files = e.target.files;
        for (const file of files) {
            const song = {
                name: file.name,
                url: URL.createObjectURL(file) // Create a temporary URL for the local file
            };
            playlist.push(song);
        }
        if (currentIndex === -1 && playlist.length > 0) {
            loadSong(0); // Load the first song but don't play
        }
        renderPlaylist();
    });

    playPauseBtn.addEventListener('click', () => {
        if (audioPlayer.paused && audioPlayer.src) playSong();
        else pauseSong();
    });
    
    prevBtn.addEventListener('click', playPrev);
    nextBtn.addEventListener('click', playNext);
    shuffleBtn.addEventListener('click', () => { isShuffle = !isShuffle; shuffleBtn.classList.toggle('active', isShuffle); });
    repeatBtn.addEventListener('click', () => { isRepeat = !isRepeat; repeatBtn.classList.toggle('active', isRepeat); });
    
    audioPlayer.addEventListener('ended', playNext);
    audioPlayer.addEventListener('timeupdate', updateProgress);
    progressWrapper.addEventListener('click', setProgress);

    // --- INITIAL RENDER ---
    renderPlaylist();
});

This snippet is using styled-components. Install it with npm i styled-components or yarn add styled-componentsThis snippet is using styled-components. Install it with npm i styled-components or yarn add styled-components

```react
import React from 'react';
import styled from 'styled-components';

const Button = () => {
  return (
    <StyledWrapper>
      <div className="va-orb-wrap">
        <input className="va-state va-state--idle" type="radio" name="va" id="va-idle" defaultChecked />
        <input className="va-state va-state--listen" type="radio" name="va" id="va-listen" />
        <input className="va-state va-state--process" type="radio" name="va" id="va-process" />
        <input className="va-state va-state--speak" type="radio" name="va" id="va-speak" />
        <div className="va-orb-button" role="button" aria-pressed="false" tabIndex={0}>
          <div className="va-orb">
            <div className="va-core" />
            <div className="va-glow" />
            <div className="va-glow-secondary" />
            <div className="va-rings" />
            <div className="va-rings va-rings--b" />
            <div className="va-wave va-wave--1" />
            <div className="va-wave va-wave--2" />
            <div className="va-wave va-wave--3" />
            <div className="va-mesh" />
            <div className="va-particles" />
          </div>
          <div className="va-center-icon">
            <div className="va-icon va-icon--idle" aria-hidden="true">
              <svg className="va-svg va-svg--idle" viewBox="0 0 48 48">
                <circle cx={24} cy={24} r={6} fill="currentColor" opacity="0.9" />
                <circle cx={24} cy={24} r={11} fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.5" />
                <circle cx={24} cy={24} r={16} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
              </svg>
            </div>
            <div className="va-icon va-icon--listen" aria-hidden="true">
              <svg className="va-svg va-svg--mic" xmlns="http://www.w3.org/2000/svg" width={1000} height={1000} viewBox="0 0 1200 1200">
                <path fill="currentColor" d="M567.626 0C537 2.389 506.974 8.271 477.905 17.065v160.913h-65.918V43.14c-29.282 14.495-57.049 32.007-82.251 52.808c-.133.11-.233.256-.366.366v657.275c.133.11.233.256.366.366C406.208 817.3 502.917 851.18 600 851.367c99.333-.036 195.305-35.544 270.264-97.412c.135-.11.234-.256.365-.366V96.313c-.133-.11-.232-.256-.365-.366c-25.031-20.735-52.406-37.949-81.078-52.222v134.253h-65.918V17.505C694.014 8.594 663.939 2.485 633.545 0v177.979h-65.918zM199.951 525.22v336.548c24.117 22.258 50.082 42.471 77.637 60.498c63.482 41.534 135.354 71.234 212.549 85.84v-38.817h219.727v38.817c77.195-14.604 149.066-44.306 212.549-85.84c27.555-18.027 53.52-38.24 77.637-60.498V525.22h-77.637v297.876c-87.98 71.849-200.15 114.99-322.412 114.99s-234.432-43.143-322.412-114.99V525.22zm509.912 482.885c-35.59 6.732-72.324 10.254-109.864 10.254s-74.274-3.521-109.863-10.254v109.496H360.131V1200h479.738v-82.396H709.863z" />
              </svg>
            </div>
            <div className="va-icon va-icon--process" aria-hidden="true">
              <svg className="va-svg va-svg--spinner" xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24">
                <path fill="currentColor" d="M21.939 5.27C21.211 4.183 20 2.941 18.784 2.137C16.258.407 13.332-.207 10.744.061c-2.699.291-5.01 1.308-6.91 3.004C2.074 4.637.912 6.559.4 8.392c-.518 1.833-.449 3.53-.264 4.808c.195 1.297.841 2.929.841 2.929c.132.313.315.44.41.493c.472.258 1.247.031 1.842-.637c.03-.041.046-.098.03-.146c-.166-.639-.226-1.12-.285-1.492c-.135-.736-.195-1.969-.105-3.109a9 9 0 0 1 .375-1.969c.406-1.367 1.262-2.794 2.6-3.98c1.441-1.277 3.289-2.066 5.046-2.27a9 9 0 0 1 3.199.203a9.6 9.6 0 0 1 2.975 1.348a8.9 8.9 0 0 1 2.374 2.363c.568.797 1.185 2.141 1.366 3.125c.256 1.12.256 2.307.074 3.463c-.225 1.158-.631 2.284-1.262 3.275c-.435.768-1.337 1.783-2.403 2.545a9.4 9.4 0 0 1-3.184 1.434a8.7 8.7 0 0 1-1.728.24c-.521.016-1.212 0-1.697-.082c-.721-.115-.871-.299-1.036-.549c0 0-.115-.18-.147-.662c.011-4.405.009-3.229.009-5.516c0-.646-.021-1.232-.015-1.764c.03-.873.104-1.473.728-2.123a2.43 2.43 0 0 1 1.777-.768c.211 0 .938.01 1.577.541c.685.572.8 1.354.827 1.563c.156 1.223-.652 2.134-.962 2.365a3.5 3.5 0 0 1-.962.51a4.1 4.1 0 0 1-1.531.182a.15.15 0 0 0-.158.119l-.165.856c-.161.65.2.888.41.972c.671.207 1.266.293 1.971.24a4.93 4.93 0 0 0 3.052-1.346a4.47 4.47 0 0 0 1.359-2.645a5.9 5.9 0 0 0-.556-3.35a5.37 5.37 0 0 0-2.81-2.583c-1.291-.508-2.318-.526-3.642-.188l-.015.005c-.86.296-1.596.661-2.362 1.452a5.4 5.4 0 0 0-1.217 1.953c-.26.752-.33 1.313-.342 2.185c-.016.646.015 1.246.015 1.808v3.701c0 1.184-.04 1.389 0 1.998c.022.404.078.861.255 1.352c.182.541.564 1.096.826 1.352c.367.391.834.705 1.293.9c1.051.467 2.478.541 3.635.496a12 12 0 0 0 2.291-.314a12.2 12.2 0 0 0 4.235-1.918c1.367-.963 2.555-2.277 3.211-3.393c.841-1.326 1.385-2.814 1.668-4.343c.255-1.532.243-3.103-.099-4.612c-.27-1.4-.991-2.936-1.823-4.176z" />
              </svg>
            </div>
            <div className="va-icon va-icon--speak" aria-hidden="true">
              <svg className="va-svg va-svg--speaker" xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24">
                <path fill="currentColor" fillRule="evenodd" d="M12 2.12a1 1 0 0 1 .812.362c.16.194.197.434.213.609c.016.182.016.415.016.68v16.5c0 .265 0 .498-.016.68c-.016.175-.053.415-.213.609a1 1 0 0 1-.812.362c-.252-.01-.455-.144-.595-.249a9 9 0 0 1-.516-.442l-3.23-2.9c-.185-.167-.223-.197-.26-.218a.5.5 0 0 0-.136-.052c-.041-.01-.09-.012-.339-.012h-1.61c-.821 0-1.47 0-1.99-.043c-.531-.043-.975-.134-1.38-.339a3.52 3.52 0 0 1-1.53-1.53c-.205-.403-.296-.847-.339-1.38c-.043-.52-.043-1.17-.043-1.99v-1.44c0-.82 0-1.47.043-1.99c.043-.53.134-.975.339-1.38a3.52 3.52 0 0 1 1.53-1.53c.403-.205.847-.296 1.38-.339c.521-.042 1.17-.042 1.99-.042h1.61c.249 0 .298-.003.339-.012a.5.5 0 0 0 .136-.053c.037-.02.075-.051.26-.218l3.23-2.9c.197-.177.37-.333.516-.443c.14-.105.343-.238.595-.249zm.005 1.05c-.106.08-.245.204-.464.401L8.3 6.481c-.14.127-.264.238-.41.32a1.5 1.5 0 0 1-.41.157a2.4 2.4 0 0 1-.518.036h-1.62c-.848 0-1.45 0-1.93.04c-.47.038-.767.111-1.01.232a2.5 2.5 0 0 0-1.09 1.09c-.122.24-.195.536-.233 1.01c-.04.475-.04 1.08-.04 1.93v1.4c0 .848 0 1.45.04 1.93c.038.47.112.767.233 1.01c.24.47.622.853 1.09 1.09c.239.122.536.195 1.01.233c.475.04 1.08.04 1.93.04h1.62c.189 0 .356 0 .519.036q.215.048.409.157c.146.081.269.194.41.32l3.24 2.91a8 8 0 0 0 .486.417l.002-.027a8 8 0 0 0 .013-.613v-16.4a8 8 0 0 0-.015-.64l-.022.016z" clipRule="evenodd" />
                <path fill="currentColor" d="M17.8 2.62a.5.5 0 0 1 .682-.187c3.32 1.89 5.56 5.47 5.56 9.56c0 4.11-2.25 7.69-5.58 9.58a.501.501 0 0 1-.494-.87c3.03-1.72 5.08-4.97 5.08-8.71c0-3.72-2.03-6.97-5.05-8.69a.5.5 0 0 1-.187-.682z" />
                <path fill="currentColor" d="M16.5 5.91a.5.5 0 0 0-.494.87a6.004 6.004 0 0 1 0 10.44a.5.5 0 0 0 .494.87A6.99 6.99 0 0 0 20.05 12c0-2.61-1.43-4.89-3.55-6.09" />
              </svg>
            </div>
          </div>
          <div className="va-label">
            <span className="va-text va-text--idle">Ready</span>
            <span className="va-text va-text--listen">Listening</span>
            <span className="va-text va-text--process">Processing</span>
            <span className="va-text va-text--speak">Speaking</span>
          </div>
        </div>
        <div className="va-dock">
          <label className="va-chip va-chip--idle" htmlFor="va-idle" tabIndex={0}>
            <span className="va-chip-icon va-ci--idle">
              <svg className="va-chip-svg" viewBox="0 0 24 24">
                <circle cx={12} cy={12} r="3.5" fill="currentColor" opacity="0.9" />
                <circle cx={12} cy={12} r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
              </svg>
            </span>
            <span className="va-chip-txt">Ready</span>
          </label>
          <label className="va-chip va-chip--listen" htmlFor="va-listen" tabIndex={0}>
            <span className="va-chip-icon va-ci--listen">
              <svg className="va-chip-svg" viewBox="0 0 24 24">
                <rect x="9.5" y={5} width={5} height={9} rx="2.5" fill="currentColor" />
                <path d="M6.5 14a5.5 5.5 0 0 0 11 0" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <line x1={12} y1={17} x2={12} y2={19} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>
            <span className="va-chip-txt">Listen</span>
          </label>
          <label className="va-chip va-chip--process" htmlFor="va-process" tabIndex={0}>
            <span className="va-chip-icon va-ci--process">
              <svg className="va-chip-svg" viewBox="0 0 24 24">
                <circle cx={12} cy={12} r={8} fill="none" stroke="currentColor" strokeWidth="1.8" opacity="0.25" />
                <path d="M12 4a8 8 0 0 1 8 8" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
              </svg>
            </span>
            <span className="va-chip-txt">Process</span>
          </label>
          <label className="va-chip va-chip--speak" htmlFor="va-speak" tabIndex={0}>
            <span className="va-chip-icon va-ci--speak">
              <svg className="va-chip-svg" viewBox="0 0 24 24">
                <path d="M8 9h3l4-3.5v13L11 15H8z" fill="currentColor" />
                <path d="M16 10.5c1 1.2 1 3.8 0 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>
            <span className="va-chip-txt">Speak</span>
          </label>
        </div>
      </div>
    </StyledWrapper>
  );
}

const StyledWrapper = styled.div`
  .va-orb-wrap {
    --va-size: 14em;
    --va-idle: #06b6d4;
    --va-listen: #10b981;
    --va-process: #8b5cf6;
    --va-speak: #f59e0b;
    --va-ink: #ffffff;
    --va-bg-dark: #0f0721;
    --va-bg-darker: #08031a;
    --va-surface: rgba(255, 255, 255, 0.08);
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: radial-gradient(
      ellipse 140% 120% at 50% 0%,
      var(--va-bg-dark),
      var(--va-bg-darker)
    );
    overflow: hidden;
    perspective: 90em;
    position: relative;
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
    padding: 1.5em;
    box-sizing: border-box;
  }

  .va-state {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .va-orb-button {
    --tone: var(--va-idle);
    position: relative;
    width: var(--va-size);
    height: calc(var(--va-size) + 3em);
    display: flex;
    flex-wrap: wrap;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    user-select: none;
    outline: none;
    cursor: pointer;
    margin-bottom: 3.5em;
  }

  .va-orb {
    position: relative;
    width: var(--va-size);
    height: var(--va-size);
    border-radius: 50%;
    transform-style: preserve-3d;
    background: radial-gradient(
        circle at 35% 30%,
        rgba(255, 255, 255, 0.25),
        transparent 50%
      ),
      radial-gradient(
        circle at 50% 50%,
        rgba(255, 255, 255, 0.08),
        transparent 65%
      ),
      radial-gradient(circle at 50% 50%, var(--tone), transparent 75%);
    box-shadow:
      0 0 3em 1em color-mix(in oklab, var(--tone) 65%, #000 35%),
      inset 0 -0.5em 2.5em 0.5em color-mix(in oklab, var(--tone) 35%, #000 65%),
      inset 0 0.5em 2em rgba(255, 255, 255, 0.15);
    transition:
      transform 0.5s cubic-bezier(0.34, 1.26, 0.64, 1),
      box-shadow 0.5s cubic-bezier(0.34, 1.26, 0.64, 1),
      background 0.6s ease;
  }

  .va-orb-button:hover .va-orb,
  .va-orb-button:focus .va-orb {
    transform: scale(1.08);
    box-shadow:
      0 0 4em 1.4em color-mix(in oklab, var(--tone) 75%, #000 25%),
      inset 0 -0.6em 3em 0.7em color-mix(in oklab, var(--tone) 40%, #000 60%),
      inset 0 0.6em 2.5em rgba(255, 255, 255, 0.2);
  }

  .va-orb-button:active .va-orb {
    transform: scale(0.96);
    transition-duration: 0.12s;
  }

  .va-orb-button:focus-visible {
    outline: 0.18em solid color-mix(in oklab, var(--tone) 85%, #fff 15%);
    outline-offset: 0.5em;
    border-radius: 50%;
  }

  .va-core {
    position: absolute;
    top: 28%;
    left: 28%;
    width: 44%;
    height: 44%;
    border-radius: 50%;
    background: radial-gradient(circle at 45% 45%, #ffffff, var(--tone) 70%);
    box-shadow:
      0 0 4em 0.3em var(--tone),
      inset 0 0 1.5em rgba(255, 255, 255, 0.6);
    animation: va-core-idle 3.8s ease-in-out infinite;
    filter: blur(0.05em);
  }

  .va-glow {
    position: absolute;
    inset: -5%;
    border-radius: 50%;
    filter: blur(1.8em);
    background: radial-gradient(
      circle at 50% 50%,
      color-mix(in oklab, var(--tone) 45%, transparent 55%),
      transparent 55%
    );
    pointer-events: none;
    opacity: 0.8;
  }

  .va-glow-secondary {
    position: absolute;
    inset: -10%;
    border-radius: 50%;
    filter: blur(2.5em);
    background: radial-gradient(
      circle at 50% 50%,
      color-mix(in oklab, var(--tone) 30%, transparent 70%),
      transparent 60%
    );
    pointer-events: none;
    opacity: 0.6;
  }

  .va-mesh {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: repeating-conic-gradient(
      from 0deg,
      transparent 0% 2.8%,
      color-mix(in oklab, var(--tone) 45%, #000 55%) 3.2% 3.5%,
      transparent 3.8%
    );
    opacity: 0.32;
    mix-blend-mode: overlay;
    animation: va-mesh-spin 30s linear infinite;
    transform: translateZ(-0.8em);
  }

  .va-particles {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(
        circle at 20% 30%,
        rgba(255, 255, 255, 0.4) 1%,
        transparent 1%
      ),
      radial-gradient(
        circle at 70% 25%,
        rgba(255, 255, 255, 0.3) 1.5%,
        transparent 1.5%
      ),
      radial-gradient(
        circle at 80% 65%,
        rgba(255, 255, 255, 0.35) 1.2%,
        transparent 1.2%
      ),
      radial-gradient(
        circle at 25% 75%,
        rgba(255, 255, 255, 0.25) 1.8%,
        transparent 1.8%
      );
    opacity: 0.5;
    pointer-events: none;
  }

  .va-rings {
    position: absolute;
    inset: -7%;
    border-radius: 50%;
    border: 0.12em solid color-mix(in oklab, var(--tone) 60%, #fff 40%);
    opacity: 0.28;
    pointer-events: none;
  }

  .va-rings--b {
    inset: -14%;
    opacity: 0.18;
    border-width: 0.1em;
  }

  .va-wave {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 0.2em solid var(--tone);
    opacity: 0;
    pointer-events: none;
  }

  .va-wave--1 {
    animation-delay: 0s;
  }

  .va-wave--2 {
    animation-delay: 0.7s;
  }

  .va-wave--3 {
    animation-delay: 1.4s;
  }

  .va-center-icon {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 4em;
    height: 4em;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--va-ink);
    pointer-events: none;
  }

  .va-icon {
    position: absolute;
    width: 4em;
    height: 4em;
    opacity: 0;
    transform: scale(0.85);
    transition:
      opacity 0.32s ease,
      transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .va-svg {
    width: 100%;
    height: 100%;
    display: block;
    filter: drop-shadow(0 0.15em 0.4em rgba(0, 0, 0, 0.5));
  }

  .va-label {
    position: absolute;
    bottom: 2em;
    width: 100%;
    height: 2.5em;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.95em;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.85);
    letter-spacing: 0.03em;
  }

  .va-text {
    position: absolute;
    opacity: 0;
    transform: translateY(0.5em);
    transition:
      opacity 0.35s ease,
      transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
    white-space: nowrap;
  }

  .va-dock {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.7em;
    width: 100%;
    padding: 0.8em;
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.06),
      rgba(255, 255, 255, 0.02)
    );
    border-radius: 3em;
    border: 0.08em solid rgba(255, 255, 255, 0.15);
    backdrop-filter: blur(1.2em);
    box-sizing: border-box;
  }

  .va-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
    padding: 0.6em 0.9em 0.6em 0.6em;
    border-radius: 2em;
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.08),
      rgba(255, 255, 255, 0.04)
    );
    color: rgba(255, 255, 255, 0.9);
    border: 0.08em solid rgba(255, 255, 255, 0.18);
    cursor: pointer;
    transition:
      transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1),
      background 0.28s ease,
      border-color 0.28s ease,
      box-shadow 0.28s ease;
    backdrop-filter: blur(0.5em);
    font-size: 0.82em;
    font-weight: 500;
    letter-spacing: 0.02em;
    flex: 1;
    justify-content: center;
    min-width: 0;
  }

  .va-chip:hover,
  .va-chip:focus {
    transform: translateY(-0.15em) scale(1.05);
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.15),
      rgba(255, 255, 255, 0.08)
    );
    border-color: rgba(255, 255, 255, 0.35);
    box-shadow:
      0 0.3em 2em rgba(255, 255, 255, 0.2),
      0 0.15em 0.8em rgba(255, 255, 255, 0.12);
  }

  .va-chip:active {
    transform: translateY(0) scale(1.02);
    transition-duration: 0.12s;
  }

  .va-chip-icon {
    width: 1.8em;
    height: 1.8em;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    color: currentColor;
    flex-shrink: 0;
    background: rgba(255, 255, 255, 0.12);
    border: 0.06em solid rgba(255, 255, 255, 0.2);
  }

  .va-chip-svg {
    width: 65%;
    height: 65%;
    display: block;
  }

  .va-chip-txt {
    font-size: 1em;
    white-space: nowrap;
    opacity: 0.95;
  }

  .va-state--idle:checked ~ .va-orb-button {
    --tone: var(--va-idle);
  }

  .va-state--idle:checked ~ .va-orb-button .va-core {
    animation: va-core-idle 4s ease-in-out infinite;
  }

  .va-state--idle:checked ~ .va-orb-button .va-text--idle {
    opacity: 1;
    transform: translateY(0);
  }

  .va-state--idle:checked ~ .va-orb-button .va-icon--idle {
    opacity: 1;
    transform: scale(1);
  }

  .va-state--idle:checked ~ .va-dock .va-chip--idle {
    background: linear-gradient(
      135deg,
      color-mix(in oklab, var(--va-idle) 90%, #fff 10%),
      color-mix(in oklab, var(--va-idle) 75%, #fff 25%)
    );
    color: #0a1a1e;
    border-color: var(--va-idle);
    box-shadow:
      0 0 1.5em color-mix(in oklab, var(--va-idle) 70%, transparent 30%),
      0 0.25em 1em color-mix(in oklab, var(--va-idle) 50%, transparent 50%);
  }

  .va-state--idle:checked ~ .va-dock .va-chip--idle .va-chip-icon {
    background: rgba(255, 255, 255, 0.3);
    animation: idle-ping 2s ease-out infinite;
  }

  .va-state--listen:checked ~ .va-orb-button {
    --tone: var(--va-listen);
  }

  .va-state--listen:checked ~ .va-orb-button .va-core {
    animation: va-core-listen 1s ease-in-out infinite;
  }

  .va-state--listen:checked ~ .va-orb-button .va-wave {
    opacity: 0.85;
    animation: va-ripple 1.8s ease-out infinite;
  }

  .va-state--listen:checked ~ .va-orb-button .va-mesh {
    animation-duration: 20s;
    opacity: 0.38;
  }

  .va-state--listen:checked ~ .va-orb-button .va-text--listen {
    opacity: 1;
    transform: translateY(0);
  }

  .va-state--listen:checked ~ .va-orb-button .va-icon--listen {
    opacity: 1;
    transform: scale(1);
  }

  .va-state--listen:checked ~ .va-orb-button .va-svg--mic {
    filter: drop-shadow(0 0 0.6em rgba(255, 255, 255, 0.7));
  }

  .va-state--listen:checked ~ .va-dock .va-chip--listen {
    background: linear-gradient(
      135deg,
      color-mix(in oklab, var(--va-listen) 90%, #fff 10%),
      color-mix(in oklab, var(--va-listen) 75%, #fff 25%)
    );
    color: #0a2214;
    border-color: var(--va-listen);
    box-shadow:
      0 0 1.5em color-mix(in oklab, var(--va-listen) 70%, transparent 30%),
      0 0.25em 1em color-mix(in oklab, var(--va-listen) 50%, transparent 50%);
  }

  .va-state--listen:checked ~ .va-dock .va-chip--listen .va-chip-icon {
    background: rgba(255, 255, 255, 0.3);
    animation: listen-pulse 1s ease-in-out infinite;
  }

  .va-state--process:checked ~ .va-orb-button {
    --tone: var(--va-process);
  }

  .va-state--process:checked ~ .va-orb-button .va-core {
    animation: va-core-process 1.3s ease-in-out infinite;
  }

  .va-state--process:checked ~ .va-orb-button .va-orb {
    animation: va-tilt 5s ease-in-out infinite;
  }

  .va-state--process:checked ~ .va-orb-button .va-mesh {
    animation-duration: 15s;
    opacity: 0.44;
  }

  .va-state--process:checked ~ .va-orb-button .va-rings {
    animation: va-orbit 7s linear infinite;
  }

  .va-state--process:checked ~ .va-orb-button .va-rings--b {
    animation: va-orbit 9s linear infinite reverse;
  }

  .va-state--process:checked ~ .va-orb-button .va-text--process {
    opacity: 1;
    transform: translateY(0);
  }

  .va-state--process:checked ~ .va-orb-button .va-icon--process {
    opacity: 1;
    transform: scale(1);
  }

  .va-state--process:checked ~ .va-orb-button .va-ring-arc {
    animation: va-spinner 1.3s linear infinite;
  }

  .va-state--process:checked ~ .va-dock .va-chip--process {
    background: linear-gradient(
      135deg,
      color-mix(in oklab, var(--va-process) 90%, #fff 10%),
      color-mix(in oklab, var(--va-process) 75%, #fff 25%)
    );
    color: #1a0d2e;
    border-color: var(--va-process);
    box-shadow:
      0 0 1.5em color-mix(in oklab, var(--va-process) 70%, transparent 30%),
      0 0.25em 1em color-mix(in oklab, var(--va-process) 50%, transparent 50%);
  }

  .va-state--process:checked ~ .va-dock .va-chip--process .va-chip-icon {
    background: rgba(255, 255, 255, 0.3);
    animation: process-rotate 1.3s linear infinite;
  }

  .va-state--speak:checked ~ .va-orb-button {
    --tone: var(--va-speak);
  }

  .va-state--speak:checked ~ .va-orb-button .va-core {
    animation: va-core-speak 0.38s ease-in-out infinite alternate;
  }

  .va-state--speak:checked ~ .va-orb-button .va-orb {
    animation: va-bounce 1.1s ease-in-out infinite;
  }

  .va-state--speak:checked ~ .va-orb-button .va-text--speak {
    opacity: 1;
    transform: translateY(0);
  }

  .va-state--speak:checked ~ .va-orb-button .va-icon--speak {
    opacity: 1;
    transform: scale(1);
  }

  .va-state--speak:checked ~ .va-dock .va-chip--speak {
    background: linear-gradient(
      135deg,
      color-mix(in oklab, var(--va-speak) 90%, #fff 10%),
      color-mix(in oklab, var(--va-speak) 75%, #fff 25%)
    );
    color: #261808;
    border-color: var(--va-speak);
    box-shadow:
      0 0 1.5em color-mix(in oklab, var(--va-speak) 70%, transparent 30%),
      0 0.25em 1em color-mix(in oklab, var(--va-speak) 50%, transparent 50%);
  }

  .va-state--speak:checked ~ .va-dock .va-chip--speak .va-chip-icon {
    background: rgba(255, 255, 255, 0.3);
    animation: speak-wave 1.1s ease-in-out infinite;
  }

  @keyframes va-core-idle {
    0%,
    100% {
      transform: scale(1);
      opacity: 1;
    }
    50% {
      transform: scale(1.12);
      opacity: 0.95;
    }
  }

  @keyframes va-core-listen {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.22);
    }
  }

  @keyframes va-core-process {
    0%,
    100% {
      transform: scale(1) rotate(0deg);
    }
    50% {
      transform: scale(1.15) rotate(180deg);
    }
  }

  @keyframes va-core-speak {
    0% {
      transform: scale(1);
    }
    100% {
      transform: scale(1.32);
    }
  }

  @keyframes va-mesh-spin {
    to {
      transform: rotate(360deg) translateZ(-0.8em);
    }
  }

  @keyframes va-orbit {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes va-ripple {
    0% {
      transform: scale(0.92);
      opacity: 0.85;
    }
    100% {
      transform: scale(1.9);
      opacity: 0;
    }
  }

  @keyframes va-tilt {
    0%,
    100% {
      transform: rotateX(0) rotateY(0) scale(1);
    }
    25% {
      transform: rotateX(10deg) rotateY(-10deg) scale(1.02);
    }
    50% {
      transform: rotateX(0) rotateY(0) scale(1);
    }
    75% {
      transform: rotateX(-10deg) rotateY(10deg) scale(1.02);
    }
  }

  @keyframes va-spinner {
    to {
      transform: rotate(720deg);
    }
  }

  @keyframes va-bounce {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-0.5em);
    }
  }

  @keyframes idle-ping {
    0% {
      box-shadow: 0 0 0 0 currentColor;
      transform: scale(1);
    }
    100% {
      box-shadow: 0 0 0 1.2em transparent;
      transform: scale(1.08);
    }
  }

  @keyframes listen-pulse {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.22);
    }
  }

  @keyframes process-rotate {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes speak-wave {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.15);
    }
  }`;

export default Button;
```

/**
 * 1200x750 stills of each direction (light and dark, stored at 720 px), taken
 * from the running page by `scripts/shots.ts`. The gallery shows these until
 * "Live" is picked, so opening it does not join seven guests to the mock host
 * at once.
 */
import classicLight from "./thumbs/classic-light.jpg";
import classicDark from "./thumbs/classic-dark.jpg";
import chamberLight from "./thumbs/chamber-light.jpg";
import chamberDark from "./thumbs/chamber-dark.jpg";
import claudeLight from "./thumbs/claude-light.jpg";
import claudeDark from "./thumbs/claude-dark.jpg";
import consoleLight from "./thumbs/console-light.jpg";
import consoleDark from "./thumbs/console-dark.jpg";
import feedLight from "./thumbs/feed-light.jpg";
import feedDark from "./thumbs/feed-dark.jpg";
import studioLight from "./thumbs/studio-light.jpg";
import studioDark from "./thumbs/studio-dark.jpg";
import slackLight from "./thumbs/slack-light.jpg";
import slackDark from "./thumbs/slack-dark.jpg";

const thumbs: Record<string, { light: string; dark: string }> = {
	classic: { light: classicLight, dark: classicDark },
	chamber: { light: chamberLight, dark: chamberDark },
	claude: { light: claudeLight, dark: claudeDark },
	console: { light: consoleLight, dark: consoleDark },
	feed: { light: feedLight, dark: feedDark },
	studio: { light: studioLight, dark: studioDark },
	slack: { light: slackLight, dark: slackDark },
};

export default thumbs;

import time
from PIL import ImageGrab

# every 1 min take a screenshot and save it to screenshot.png in current path
while True:
	screenshot = ImageGrab.grab()
	screenshot.save("screenshot.png")
	screenshot.close()
	time.sleep(60)